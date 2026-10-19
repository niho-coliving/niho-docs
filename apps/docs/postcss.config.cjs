const tailwindcss = require("@tailwindcss/postcss");

const accountScopedLayers = new Set(["theme", "utilities"]);
const scopeAccountTailwind = {
  postcssPlugin: "niho-docs-account-tailwind-scope",
  OnceExit(root) {
    root.walkRules((rule) => {
      let layer = null;
      let insideKeyframes = false;
      for (
        let parent = rule.parent;
        parent && parent.type !== "root";
        parent = parent.parent
      ) {
        if (parent.type === "atrule" && parent.name === "layer") {
          const candidate = parent.params.trim();
          if (accountScopedLayers.has(candidate)) layer = candidate;
        }
        if (
          parent.type === "atrule" &&
          /^(?:-[a-z]+-)?keyframes$/i.test(parent.name)
        ) {
          insideKeyframes = true;
        }
      }
      if (!layer || insideKeyframes) return;

      rule.selectors = [
        ...new Set(
          rule.selectors.map((selector) => {
            const normalized = selector.trim();
            if (layer === "theme" && (normalized === ":root" || normalized === ":host")) {
              return ":where([data-docs-app-root]) .docs-account";
            }
            return `:where([data-docs-app-root]) .docs-account ${normalized}`;
          }),
        ),
      ];
    });

    root.walkAtRules("layer", (rule) => {
      if (!accountScopedLayers.has(rule.params.trim()) || !rule.nodes || !rule.parent) return;
      for (const child of [...rule.nodes]) rule.parent.insertBefore(rule, child);
      rule.remove();
    });
  },
};

module.exports = {
  plugins: [tailwindcss(), scopeAccountTailwind],
};
