export const name = 'verify-exports-no-dot';

// `main` points here and doctor can see this export, but Node never reads
// `main` once the package has an `exports` map without a `.` entry.
export function apply() {}
