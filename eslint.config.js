import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "node_modules/**", "data/**", ".convex/**", "drizzle/meta/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
