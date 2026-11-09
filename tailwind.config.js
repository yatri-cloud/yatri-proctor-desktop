/** Yatri Cloud tokens (DESIGN.md): blue #007CFF, ink #171717, canvas #fafafa. */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { brand: "#007CFF", ink: "#171717", canvas: "#fafafa", line: "#e5e5e5", muted: "#6b7280" },
      fontFamily: { sans: ['"Inter Tight"', "Inter", "system-ui", "sans-serif"], display: ['"Bricolage Grotesque"', '"Inter Tight"', "system-ui", "sans-serif"] },
      borderRadius: { xl: "12px", "2xl": "16px", "3xl": "24px" },
    },
  },
};
