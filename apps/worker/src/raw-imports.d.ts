// Vite/Vitest `?raw` imports (tests only): the file's text as a string.
declare module '*?raw' {
  const text: string;
  export default text;
}
