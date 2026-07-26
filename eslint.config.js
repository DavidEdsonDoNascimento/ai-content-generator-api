import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `src/generated/**` é o Prisma Client gerado: não é código nosso, muda a
    // cada `prisma generate` e não deve ser avaliado pelas nossas regras.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/generated/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    // Todo TypeScript do repositório entra no lint com tipagem — os três globs
    // correspondem ao `include` do tsconfig.json, então o `projectService`
    // sempre encontra um projeto para o arquivo.
    files: [
      'src/**/*.ts',
      'prisma/**/*.ts',
      'test/**/*.ts',
      'prisma.config.ts',
      'vitest.config.ts',
      'vitest.e2e.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Regra explícita do AGENTS.md: `any` só com justificativa escrita na linha
      // (o desvio pontual usa `eslint-disable-next-line` com o motivo).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Plugins e handlers do Fastify são assíncronos por contrato de assinatura,
      // mesmo quando o corpo não tem `await`.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Arquivos de configuração em JS ficam fora do programa TypeScript.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
