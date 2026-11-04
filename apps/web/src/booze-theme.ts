import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export const boozeTheme = defineTheme({
  name: "booze",
  extends: neutralTheme,
  color: {
    accent: "#7c2742",
    contrast: "standard",
    neutralStyle: "warm",
  },
  tokens: {
    "--color-text-secondary": ["#564146", "#C6ADB2"],
  },
  radius: {
    base: 4,
    multiplier: 1,
  },
});
