import ts from "typescript";
import path from "path";
import fs from "fs";
import * as espree from "espree";
import estraverse from "estraverse";

let target = path.resolve("src/index.js");

let compilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
};

let baseHost = ts.createCompilerHost(compilerOptions, true);

function serializeNode(node) {
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "Literal":
      return node.value;
    case "MemberExpression":
      return `${serializeNode(node.object)}.${serializeNode(node.property)}`;
  }

  throw new Error(`Attempt to serialize unknown node ${node.type}`);
}

function patchFile(fileName, languageVersionOrOptions) {
  console.log(`patchFile ${fileName}`);

  let sourceText = fs.readFileSync(fileName, { encoding: "utf8" });

  let ast = espree.parse(sourceText, {
    range: true,
    loc: true,
    ecmaVersion: "latest",
    sourceType: "module",
  });

  const ConstPositions = new Map();
  const LazyTypes = new Map();

  const NodeVisitor = {
    VariableDeclaration(node) {
      if (node.declarations.length != 1) {
        return;
      }

      ConstPositions.set(serializeNode(node.declarations[0].id), node.start);
    },
    ExpressionStatement(node) {
      if (node.expression.type != "CallExpression") {
        return;
      }

      if (
        serializeNode(node.expression.callee) !=
        "ChromeUtils.defineESModuleGetters"
      ) {
        return;
      }

      // Blindly assume the types are correct now!

      let lazyObject = serializeNode(node.expression.arguments[0]);
      let props = ["/**", " * @typedef {Object} LazyImports"];

      for (let prop of node.expression.arguments[1].properties) {
        props.push(
          ` * @property {import("${serializeNode(
            prop.value
          )}")} ${serializeNode(prop.key)}`
        );
      }

      props.push(" */\n");
      props.push("/** @type {LazyImports} */");
      props.push("// @ts-ignore\n");

      LazyTypes.set(lazyObject, props.join("\n"));
    },
  };

  estraverse.traverse(ast, {
    enter(node, parent) {
      if (node.type == "Program") {
        return;
      }

      if (parent?.type == "Program" && node.type in NodeVisitor) {
        NodeVisitor[node.type](node);
      }

      return estraverse.VisitorOption.Skip;
    },
  });

  for (let [obj, props] of LazyTypes) {
    let position = ConstPositions.get(obj);
    if (position === undefined) {
      console.warn(`Unknown lazy object ${obj}`);
      continue;
    }

    let head = sourceText.substring(0, position);
    let tail = sourceText.substring(position);

    sourceText = head + props + tail;
  }

  return ts.createSourceFile(
    fileName,
    sourceText,
    languageVersionOrOptions,
    true
  );
}

let host = Object.create(baseHost, {
  getSourceFile: {
    value(fileName, languageVersionOrOptions, ...args) {
      let fullName = path.resolve(fileName);
      if (fullName == target) {
        return patchFile(fullName, languageVersionOrOptions);
      }
      return baseHost.getSourceFile(fileName, ...args);
    },
  },
});

let program = ts.createProgram(
  ["src/index.js", "src/module.js", "src/index.d.ts"],
  compilerOptions,
  host
);

function logDiagnostics(diagnostics) {
  for (let diag of diagnostics) {
    console.error(`ts(${diag.code}): ${diag.messageText}`);
  }
}

logDiagnostics(program.getSyntacticDiagnostics());
logDiagnostics(program.getSemanticDiagnostics());
