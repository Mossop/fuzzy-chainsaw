const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Module: "./module",
});

let foo = lazy.Module.add("6", 5);
