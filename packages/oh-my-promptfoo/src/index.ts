// The package root exports nothing: providers live in `oh-my-promptfoo/providers` and
// assertions in `oh-my-promptfoo/assertions`. The root entry still resolves, so Promptfoo
// reports an unknown root id such as `package:oh-my-promptfoo:Agent` as a missing entity
// rather than a missing package.
export {};
