/**
 * Type-level equality for the contract tests: `true` only when `A` and `B` are
 * the same type (optionality, readonly-ness and `any` included). Assign a
 * result to a `true`-typed constant so a mismatch fails `pnpm lint`.
 */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** One level of an object type, flattened, so an intersection and an interface compare by members. */
type Flat<T> = { [K in keyof T]: T[K] };

/** {@link Equals} after flattening both sides one level: `Core.X & { … }` equals an interface with the same members. */
export type Same<A, B> = Equals<Flat<A>, Flat<B>>;
