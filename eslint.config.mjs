// eslint-config-next 16 ships flat configs directly, so no FlatCompat shim.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // `const { privateKey: _privateKey, ...rest } = key` is how we drop a
      // secret from an API response. The binding is unused on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Client pages load their data on mount and refetch after a mutation.
    // react-hooks v7 flags `load()` inside useEffect because `load` transitively
    // calls setState, but it cannot see that every one of those calls sits behind
    // an await — which is exactly the "setState in a callback when external state
    // changes" case the rule's own documentation permits. The rule stays on
    // everywhere else, where a genuinely synchronous setState is a real bug.
    files: ['app/**/page.tsx'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // `ui/` kommt ohne zwei Regeln von Next aus: `ToolShell` lädt die Sitzung beim
    // Einhängen (derselbe Fall wie bei den Seiten oben), und ein QR-Code oder ein
    // Symbol aus einer Daten-URL ist kein Bild, das `next/image` verkleinern könnte.
    files: ['ui/**'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      '@next/next/no-img-element': 'off',
    },
  },
];

export default config;
