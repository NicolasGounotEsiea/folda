/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0c0c0c",
          1: "#131313",
          2: "#1a1a1a",
          3: "#222222",
          4: "#2a2a2a",
          5: "#333333",
        },
        accent: {
          DEFAULT: "#6366f1",
          dim: "#4f46e5",
          glow: "#818cf8",
        },
        border: {
          DEFAULT: "#2a2a2a",
          subtle: "#1f1f1f",
        },
        text: {
          primary: "#e8e8e8",
          secondary: "#888888",
          muted: "#555555",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
