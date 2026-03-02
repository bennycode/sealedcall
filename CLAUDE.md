# CLAUDE.md

## TypeScript Best Practices

### Type Inference

- Let TypeScript infer types as the default. Only annotate when context is necessary.
- Always annotate function parameters — TypeScript cannot infer them.
- Enable `noImplicitAny` (included in `strict: true`) to catch implicit `any`.
- Use `const` over `let` — `const` infers literal types, `let` infers broader types.
- Explicit return types are required for recursive functions and exported functions (`isolatedDeclarations`).

### Type Aliases over Interfaces

- Prefer `type` over `interface` for most type definitions.
- Use `interface` only when you specifically need declaration merging.

### Never Use `any`

- Use `unknown` instead of `any` — it forces narrowing before use.
- Type catch clause errors as `unknown`: `catch (error: unknown)`.
- When third-party functions return `any`, assign the result to `unknown`.
- Enable `noImplicitAny` to catch untyped parameters.

### Type Assertions

- Avoid `as` assertions in business logic — reserve them for test fixtures.
- Prefer `Pick<T, K>` to narrow function signatures so assertions become unnecessary.
- Use `as const` for immutable configs and fixed value sets.
- Use `as const satisfies T` to validate shape while preserving literal inference.
- Prefer `@ts-expect-error` over `@ts-ignore` for intentional type errors.

### Union Types

- Use literal union types instead of broad types: `"admin" | "user"` over `string`.
- Prefer `as const` objects + union types over `enum`s — enums generate runtime code and aren't tree-shakeable.
- Use discriminated unions with a shared `type`/`kind` property for structured branching.
- Combine discriminated unions with `switch` for exhaustive handling.

### Exhaustiveness Checking

- Use `never` in `default` cases to catch unhandled union members at compile time:

```ts
default:
  const _exhaustive: never = value;
  throw new Error(`Unhandled: ${_exhaustive}`);
```

### Utility Types

- `Partial<T>` for update/patch operations.
- `Pick<T, K>` to narrow function parameters — avoids accepting full objects.
- `Omit<T, K>` to exclude properties.
- `Required<T>` to make optional properties mandatory.
- `Readonly<T>` for immutability.
- `Record<K, V>` for controlled object structures.
- `ReturnType<T>` and `Awaited<T>` to derive types from implementations.
- `Extract<T, U>` to pull specific members from a union.
- `NonNullable<T>` for null/undefined filtering.
- Combine utility types: `Required<Pick<T, K>> & Partial<Omit<T, K>>`.
- Use utility types on third-party types rather than duplicating them.

### Narrowing

- Use `typeof` for primitives, `instanceof` for classes.
- Use truthiness checks for optional values.
- Use the `in` operator for structurally distinct union members.
- Use `===` / `!==` for literal union members.
- Write user-defined type guards (`value is T`) for reusable narrowing.
- Use assertion functions (`asserts value is T`) for defensive programming.
- Use type predicates with `filter()` for type-safe array transformations.
- TS 5.5+ can auto-infer type predicates from `filter()` — explicit predicates may be unnecessary.

### Readonly by Default

- Mark object type properties as `readonly` when they shouldn't be mutated.
- Use `readonly T[]` for array parameters that aren't mutated.
- Use `Readonly<T>` for object parameters.
- Use `as const` for configuration objects.

### Imports

- Use `import type` for type-only imports.
- Enable `verbatimModuleSyntax` in tsconfig to enforce this.

### Strict Configuration

- Always use `strict: true` in tsconfig.
- Enable `noUncheckedIndexedAccess` — array/object index access returns `T | undefined`.
- Enable `noFallthroughCasesInSwitch`.
- Enable `forceConsistentCasingInFileNames`.
- Consider `exactOptionalPropertyTypes` to distinguish `undefined` from missing.
- Consider `isolatedDeclarations` to force explicit return types on exports.

### Modern TypeScript (5.x)

- `as const satisfies T` — validate shape while preserving literal inference (TS 5.0).
- `const` type parameters — infer literal types from arguments (TS 5.0).
- `using` / `await using` — automatic resource cleanup via `Symbol.dispose` (TS 5.2).
- `NoInfer<T>` — prevent unwanted inference from specific argument positions (TS 5.4).
- Inferred type predicates — TS 5.5 auto-infers guards from `filter()` callbacks.
- `isolatedDeclarations` — enables parallel `.d.ts` generation (TS 5.5).

### Patterns

- Use `void` prefix for intentionally floating promises: `void sendAnalytics()`.
- Use `void` return type for side-effect functions.
- Use `for...of` instead of `.forEach()` — narrowing doesn't persist across callback boundaries.
- Use `??` over `||` for nullish coalescing — only catches `null`/`undefined`.
- Use branded types when structurally identical types need semantic distinction.
- Use `Record<string, never>` for empty objects — `{}` matches almost anything.
- Use template literal types for string pattern constraints.

### Anti-Patterns

- Never use `any` in production code.
- Never use traditional `enum` — prefer `as const` objects.
- Never access `error.message` without narrowing in catch blocks.
- Never rely on non-null assertions (`!`) when narrowing is possible.
- Never use `namespace` — use ES modules.
- Never duplicate types — derive them with utility types or `typeof`/`ReturnType`.
- Never use broad types (`string`, `number`) when literal unions are more precise.
