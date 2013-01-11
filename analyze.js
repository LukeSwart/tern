var acorn = require("acorn"), walk = require("acorn/util/walk");
var fs = require("fs");

var aval = require("./aval");
var AVal = aval.AVal, Obj = aval.Obj, Fn = aval.Fn;

function Var(node) {
  this.node = node;
  this.aval = new AVal;
}
function Scope(prev) {
  this.vars = Object.create(null);
  this.prev = prev;
}

function lookup(name, scope) {
  for (; scope; scope = scope.prev) {
    var found = scope.vars[name];
    if (found) return found;
  }
}
function topScope(scope) {
  while (scope.prev) scope = scope.prev;
  return scope;
}

var scopeGatherer = walk.make({
  Function: function(node, scope, c) {
    var inner = node.body.scope = new Scope(scope), argvals = inner.argvals = [];
    for (var i = 0; i < node.params.length; ++i) {
      var param = node.params[i], v = new Var(param);
      inner.vars[param.name] = v;
      argvals.push(v.aval);
    }
    inner.retval = new AVal;
    inner.self = new AVal;
    if (node.id) {
      var decl = node.type == "FunctionDeclaration";
      (decl ? scope : inner).vars[node.id.name] = new Var(node.id);
    }
    c(node.body, inner, "ScopeBody");
  },
  TryStatement: function(node, scope, c) {
    c(node.block, scope, "Statement");
    for (var i = 0; i < node.handlers.length; ++i) {
      var handler = node.handlers[i], name = handler.param.name;
      if (!(name in scope.vars)) scope.vars[name] = new Var(handler.param);
      c(handler.body, scope, "ScopeBody");
    }
    if (node.finalizer) c(node.finalizer, scope, "Statement");
  },
  VariableDeclaration: function(node, scope, c) {
    for (var i = 0; i < node.declarations.length; ++i) {
      var decl = node.declarations[i];
      if (!(decl.id.name in scope.vars))
        scope.vars[decl.id.name] = new Var(decl.id);
      if (decl.init) c(decl.init, scope, "Expression");
    }
  }
});

function hasType(type, set) {
  return set == type || set.types && set.types.indexOf(type) > -1;
}

function PropIsSubset(prop, target) { this.target = target; this.prop = prop; }
PropIsSubset.prototype.addType = function(type) {
  if (type.ensureProp)
    type.ensureProp(this.prop).propagate(this.target);
};

function PropHasSubset(prop, target) { this.target = target; this.prop = prop; }
PropHasSubset.prototype.addType = function(type) {
  if (type.ensureProp)
    this.target.propagate(type.ensureProp(this.prop));
};

function IsCallee(self, args, retval) { this.self = self; this.args = args; this.retval = retval; }
IsCallee.prototype.addType = function(type) {
  if (!(type instanceof Fn)) return;
  for (var i = 0, e = Math.min(this.args.length, type.args.length); i < e; ++i)
    this.args[i].propagate(type.args[i]);
  if (this.self) this.self.propagate(type.self);
  type.retval.propagate(this.retval);
};

function IsAdded(other, target) { this.other = other; this.target = target; }
IsAdded.prototype.addType = function(type) {
  if (type == aval._str)
    this.target.addType(aval._str);
  else if (type == aval._num && hasType(aval._num, other))
    this.target.addType(aval._num);
};


function assignVar(name, scope, aval) {
  var found = lookup(name, scope);
  if (!found) found = topScope(scope).vars[name] = new Var();
  aval.propagate(found.aval);
}

function propName(node, scope, c) {
  if (node.type == "Identifier") return node.name;
  if (node.type == "Literal" && typeof node.value == "string") return node.value;
  runInfer(node, scope, c);
  return "<i>";
}

function unopResultType(op) {
  switch (op) {
  case "+": case "-": case "~": return aval._num;
  case "!": return aval._bool;
  case "typeof": return aval._str;
  case "void": case "delete": return aval._undef;
  }
}
function binopResultType(op) {
  switch (op) {
  case "==": case "!=": case "===": case "!==": case "<": case ">": case ">=": case "<=":
  case "in": case "instanceof": return aval._bool;
  default: return aval._num;
  }
}
function literalType(val) {
  switch (typeof val) {
  case "boolean": return aval._bool;
  case "number": return aval._num;
  case "string": return aval._str;
  case "object":
    if (!val) return aval._null;
    return new Obj(); // FIXME point to single regexp obj
  }
}

function join(a, b) {
  if (a == b) return a;
  var joined = new AVal;
  a.propagate(joined); b.propagate(joined);
  return joined;
}

// FIXME cache retval and prop avals in their parents?
var inferExprVisitor = {
  ArrayExpression: function(node, scope, c) {
    var eltval = new AVal;
    for (var i = 0; i < node.elements.length; ++i) {
      var elt = node.elements[i];
      if (elt) eltval.propagate(runInfer(elt, scope, c));
    }
    return new Obj({"<i>": eltval});
  },
  ObjectExpression: function(node, scope, c) {
    var props = {};
    for (var i = 0; i < node.properties.length; ++i) {
      var p = node.properties[i];
      props[p.key.name] = runInfer(p.value, scope, c);
    }
    return new Obj(props);
  },
  FunctionExpression: function(node, scope, c) {
    var inner = node.body.scope;
    var aval = new AVal(new Fn(inner.self, inner.argvals, inner.retval));
    if (node.id)
      assignVar(node.id.name, node.body.scope, aval);
    c(node.body, scope, "ScopeBody");
    return aval;
  },
  SequenceExpression: function(node, scope, c) {
    var v;
    for (var i = 0; i < node.expressions.length; ++i)
      v = runInfer(node.expressions[i], scope, c);
    return v;
  },
  UnaryExpression: function(node, scope, c) {
    runInfer(node.argument, scope, c);
    return unopResultType(node.operator);
  },
  UpdateExpression: function(node, scope, c) {
    runInfer(node.argument, scope, c);
    return aval._num;
  },
  BinaryExpression: function(node, scope, c) {
    var lhs = runInfer(node.left, scope, c);
    var rhs = runInfer(node.right, scope, c);
    if (node.operator == "+") {
      if (hasType(aval._str, lhs) || hasType(aval._str, rhs)) return aval._str;
      if (hasType(aval._num, lhs) && hasType(aval._num, rhs)) return aval._num;
      var result = new AVal;
      lhs.propagage(new IsAdded(rhs, result));
      rhs.propagage(new IsAdded(lhs, result));
      return result;
    }
    return binopResultType(node.operator);
  },
  AssignmentExpression: function(node, scope, c) {
    var rhs = runInfer(node.right, scope, c);
    if (node.operator != "=" && node.operator != "+=")
      rhs = aval._num;

    if (node.left.type == "MemberExpression") {
      var obj = runInfer(node.left.object, scope, c);
      obj.propagate(new PropHasSubset(propName(node.left.property, scope, c), rhs));
    } else { // Identifier
      assignVar(node.left.name, scope, rhs);
    }
    return rhs;
  },
  LogicalExpression: function(node, scope, c) {
    return join(runInfer(node.left, scope, c),
                runInfer(node.right, scope, c));
  },
  ConditionalExpression: function(node, scope, c) {
    runInfer(node.test, scope, c);
    return join(runInfer(node.consequent, scope, c),
                runInfer(node.alternate, scope, c));
  },
  NewExpression: function(node, scope, c) {
    return this.CallExpression(node, scope, c, true);
  },
  CallExpression:function(node, scope, c, isNew) {
    var callee, self, args = [];
    if (isNew) {
      callee = runInfer(node.callee, scope, c);
      self = new AVal;
      callee.propagate(new PropIsSubset("prototype", self));
    } else if (node.callee.type == "MemberExpression") {
      self = runInfer(node.callee.object, scope, c);
      callee = new AVal;
      self.propagate(new PropIsSubset(propName(node.callee.property, scope, c), callee));
    } else {
      callee = runInfer(node.callee, scope, c)
    }
    if (node.arguments) for (var i = 0; i < node.arguments.length; ++i)
      args.push(runInfer(node.arguments[i], scope, c));
    var retval = new AVal;
    callee.propagate(new IsCallee(self, args, retval));
    return isNew ? self : retval;
  },
  MemberExpression: function(node, scope, c) {
    var obj = runInfer(node.object, scope, c);
    var result = new AVal;
    obj.propagate(new PropIsSubset(propName(node.property, scope, c), result));
    return result;
  },
  Identifier: function(node, scope) {
    var found = lookup(node.name, scope);
    if (!found) found = topScope(scope).vars[node.name] = new Var();
    return found.aval;
  },
  ThisExpression: function(node, scope, c) {
    for (var s = scope; !s.self; s = s.prev) {}
    return s ? s.self : aval._undef;
  },
  Literal: function(node) {
    return new literalType(node.value);
  }
};

function runInfer(node, scope, c) {
  return inferExprVisitor[node.type](node, scope, c);
}

var inferWrapper = walk.make({
  Expression: runInfer,
  
  ScopeBody: function(node, scope, c) { c(node, node.scope || scope); },

  FunctionDeclaration: function(node, scope, c) {
    var inner = node.body.scope;
    var aval = new AVal(new Fn(inner.self, inner.argvals, inner.retval));
    assignVar(node.id.name, scope, aval);
    c(node.body, scope, "ScopeBody");
  },

  VariableDeclaration: function(node, scope, c) {
    for (var i = 0; i < node.declarations.length; ++i) {
      var decl = node.declarations[i];
      if (decl.init) assignVar(decl.id.name, scope, runInfer(decl.init, scope, c));
    }
  },

  ReturnStatement: function(node, scope, c) {
    if (node.argument)
      runInfer(node.argument, scope, c).propagate(scope.retval);
  }
});

var analyze = exports.analyze = function(file) {
  var text = fs.readFileSync(file, "utf8");
  var ast = acorn.parse(text);
  var top = new Scope();
  walk.recursive(ast, top, null, scopeGatherer);
  walk.recursive(ast, top, null, inferWrapper);
  return {ast: ast, text: text, env: top, file: file};
}