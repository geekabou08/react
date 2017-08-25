const {
  AbstractValue,
  ArrayValue,
  FunctionValue,
  ObjectValue,
  NullValue,
  NumberValue,
  SymbolValue,
  UndefinedValue
} = require("prepack/lib/values");
const t = require("babel-types");
const travser = require("./traverser");

function getFunctionReferenceName(functionValue) {
  if (functionValue.__originalName) {
    return functionValue.__originalName;
  }
  const namer = functionValue.properties.get("name");
  if (namer && namer.descriptor.value.value) {
    return namer.descriptor.value.value;
  }
  return null;
}

function convertExpressionToJSXIdentifier(expr) {
  switch (expr.type) {
    case "Identifier":
      return t.jSXIdentifier(expr.name);
    case "StringLiteral":
      return t.jSXIdentifier(expr.value);
    case "MemberExpression":
      if (expr.computed) {
        throw new Error("Cannot inline computed expressions in JSX type.");
      }
      return t.jSXMemberExpression(
        convertExpressionToJSXIdentifier(expr.object),
        convertExpressionToJSXIdentifier(expr.property)
      );
    case "ArrowFunctionExpression":
      return expr;
    default:
      throw new Error("Invalid JSX Type: " + expr.type);
  }
}

function convertKeyValueToJSXAttribute(key, value) {
  let expr = convertValueToExpression(value);
  return t.jSXAttribute(
    t.jSXIdentifier(key),
    expr.type === "StringLiteral" ? expr : t.jSXExpressionContainer(expr)
  );
}

function convertReactElementToJSXExpression(objectValue) {
  let typeValue = objectValue.properties.get("type").descriptor.value;
  let keyValue = objectValue.properties.get("key").descriptor.value;
  let refValue = objectValue.properties.get("ref").descriptor.value;
  let propsValue = objectValue.properties.get("props").descriptor.value;

  let identifier = convertExpressionToJSXIdentifier(
    convertValueToExpression(typeValue)
  );
  let attributes = [];
  let children = [];

  if (!(keyValue instanceof UndefinedValue || keyValue instanceof NullValue)) {
    attributes.push(convertKeyValueToJSXAttribute("key", keyValue));
  }

  if (!(refValue instanceof UndefinedValue || refValue instanceof NullValue)) {
    attributes.push(convertKeyValueToJSXAttribute("ref", refValue));
  }
  if (propsValue.properties) {
    for (let [key, propertyBinding] of propsValue.properties) {
      let desc = propertyBinding.descriptor;
      if (desc === undefined) continue; // deleted

      if (key === "key" || key === "ref") {
        throw new Error(key + " is a reserved prop name");
      }

      if (key === "children") {
        let expr = convertValueToExpression(desc.value);
        let elements = expr.type === "ArrayExpression" && expr.elements.length > 1
          ? expr.elements
          : [expr];
        children = elements.map(
          expr =>
            (expr === null
              ? t.jSXExpressionContainer(t.jSXEmptyExpression())
              : expr.type === "StringLiteral"
                  ? t.jSXText(expr.value)
                  : expr.type === "JSXElement"
                      ? expr
                      : t.jSXExpressionContainer(expr))
        );
        continue;
      }

      attributes.push(convertKeyValueToJSXAttribute(key, desc.value));
    }
  } else {
    // TODO: this is abstract, probably from a createElement or cloneElement
  }

  if (identifier.type === 'ArrowFunctionExpression') {
    // we don't have the name here, so we have to find it
    // luckily I hacked it on to the BlockStatement body of the arrow function
    if (identifier.body.func !== undefined) {
      identifier = t.JSXIdentifier(identifier.body.func.name);
    } else if (identifier.params.func !== undefined) {
      // if its not there, I also hacked it onto the arguments
      identifier = t.JSXIdentifier(identifier.params.func.name);
    } else {
      // we need to do more hacking?
      debugger;

    }
  }

  let openingElement = t.jSXOpeningElement(
    identifier,
    attributes,
    children.length === 0
  );
  let closingElement = t.jSXClosingElement(identifier);

  return t.jSXElement(
    openingElement,
    closingElement,
    children,
    children.length === 0
  );
}

function convertObjectValueToObjectLiteral(objectValue) {
  let properties = [];
  for (let [key, propertyBinding] of objectValue.properties) {
    let desc = propertyBinding.descriptor;
    if (desc === undefined) continue; // deleted
    let expr = convertValueToExpression(desc.value);
    let property = t.objectProperty(t.stringLiteral(key), expr, false);
    properties.push(property);
  }
  return t.objectExpression(properties);
}

function convertArrayValueToArrayLiteral(arrayValue) {
  let lengthProperty = arrayValue.properties.get("length");
  if (
    !lengthProperty ||
    !(lengthProperty.descriptor.value instanceof NumberValue)
  ) {
    throw new Error("Invalid length");
  }
  let length = lengthProperty.descriptor.value.value;
  let elements = [];
  for (let i = 0; i < length; i++) {
    let elementProperty = arrayValue.properties.get("" + i);
    let elementValue =
      elementProperty &&
      elementProperty.descriptor &&
      elementProperty.descriptor.value;
    elements.push(elementValue ? convertValueToExpression(elementValue) : null);
  }
  return t.arrayExpression(elements);
}

function convertValueToExpression(value) {
  if (value instanceof AbstractValue) {
    let serializedArgs = value.args.map(abstractArg => 
      convertValueToExpression(abstractArg)
    );
    return value.buildNode(serializedArgs);
  }
  if (value.isIntrinsic()) {
    return t.identifier(value.intrinsicName);
  }
  if (value instanceof FunctionValue) {
    // TODO: Get a proper reference from a lexical map of names instead.
    const name = getFunctionReferenceName(value);
    if (name !== null) {
      return t.identifier(name);
    } else {
      // TODO: assume an arrow function for now?
      return t.arrowFunctionExpression(
        value.$FormalParameters,
        value.$ECMAScriptCode
      );
    }
  }
  if (value instanceof ObjectValue) {
    if (value.properties.has("$$typeof")) {
      // TODO: Also compare the value to ensure it's the symbol
      return convertReactElementToJSXExpression(value);
    }
    if (value instanceof ArrayValue) {
      return convertArrayValueToArrayLiteral(value);
    }
    // TODO: Handle all the object special cases.
    return convertObjectValueToObjectLiteral(value);
  }
  if (value instanceof SymbolValue) {
    return t.nullLiteral();
  }
  return t.valueToNode(value.serialize());
}

function serializeEvaluatedFunction(functionValue, args, evaluatedReturnValue) {
  let name = getFunctionReferenceName(functionValue);
  let params = args.map(arg => {
    let intrinsicName = arg.intrinsicName;
    if (!intrinsicName) {
      throw new Error("Expected arguments to have an intrinsic name");
    }
    return t.identifier(intrinsicName);
  });
  let bodyExpr = convertValueToExpression(evaluatedReturnValue);
  let returnStatement = t.returnStatement(bodyExpr);
  let body = t.blockStatement([returnStatement]);
  return t.functionDeclaration(t.identifier(name), params, body);
}

exports.convertValueToExpression = convertValueToExpression;

exports.serializeEvaluatedFunction = serializeEvaluatedFunction;
