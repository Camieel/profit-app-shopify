/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{tsx,ts}"],
  corePlugins: { preflight: false }, // ← KRITIEK: voorkomt conflict met Polaris
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"] },
      colors: {
        profit: "#16a34a",
        loss:   "#dc2626",
      }
    }
  }
}