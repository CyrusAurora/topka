// The English (or any other) dictionary must have exactly the keys of the Chinese one, with a string
// where Chinese has a string and a function of the same arguments where Chinese has a function.
export type Shape<T> = T extends string
  ? string
  : T extends (...args: infer A) => string
    ? (...args: A) => string
    : T extends readonly (infer U)[]
      ? readonly Shape<U>[]
      : { readonly [K in keyof T]: Shape<T[K]> };
