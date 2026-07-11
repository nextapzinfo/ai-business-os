/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // AiSensy-style dark teal/green — used for sidebar, headers, primary actions.
        primary: {
          dark: "#0c2c28",
          DEFAULT: "#12403a",
          light: "#1a5a4f",
        },
        accent: {
          DEFAULT: "#16a34a",
          light: "#dcfce7",
        },
      },
      borderRadius: {
        xl: "0.875rem",
      },
    },
  },
  plugins: [],
};
