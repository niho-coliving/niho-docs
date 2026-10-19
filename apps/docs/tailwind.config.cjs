/** 共通アカウントの Tailwind v4 theme。source と selector scope は account.css / PostCSS で管理する。 */
module.exports = {
  theme: { extend: require("../../packages/ui/tailwind-theme.cjs").extend },
};
