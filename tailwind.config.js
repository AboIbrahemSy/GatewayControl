/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07100f',
          900: '#0b1715',
          850: '#10201d',
          800: '#152925',
        },
        mint: {
          300: '#77e6bd',
          400: '#45d6a1',
          500: '#22b982',
        },
        sand: {
          50: '#faf9f5',
          100: '#f3f0e8',
        },
      },
      boxShadow: {
        panel: '0 24px 80px -34px rgba(15, 44, 38, 0.22)',
        glow: '0 0 48px rgba(69, 214, 161, 0.16)',
      },
    },
  },
  plugins: [],
}
