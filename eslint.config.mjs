import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = [
  { ignores: ['.next/**', 'node_modules/**', 'supabase/.temp/**'] },
  ...nextCoreWebVitals,
];

export default eslintConfig;
