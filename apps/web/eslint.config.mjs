import nextPlugin from '@next/eslint-plugin-next';
import root from '../../eslint.config.mjs';

export default [
  ...root,
  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
];
