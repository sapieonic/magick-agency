import { parsePath, type Navigator, type To } from 'react-router-dom';

/**
 * Holding navigation away from a page (`useUnsavedChangesGuard`), in one place per navigator.
 *
 * The console's router is a plain `<Router>` over `UrlScopeProvider`'s browser history, not a
 * data router, so react-router's `useBlocker` is not there. Instead the navigator's `push`,
 * `replace` and `go` are wrapped ONCE, the first time anything asks for the navigator's blockers
 * (`UrlScopeProvider`, as it creates its history; a unit test's memory router, when its first
 * guard mounts), and the wrapper asks a stack of blockers that pages add and remove. Nothing is
 * patched per page, so two guards mounted together can go in any order.
 *
 * Back and Forward never reach the navigator: `UrlScopeProvider` hears them first and asks the
 * same stack ({@link NavigationBlockers.ask}).
 */

export interface NavigationAttempt {
  /**
   * Where it goes, as the navigator writes it (with the router's basename), or as the address
   * bar shows it for a Back or Forward. `null` for a step by count (`navigate(-1)`), whose
   * destination is not known until it is taken.
   */
  pathname: string | null;
}

/**
 * Return true to hold the attempt. `proceed` carries it out later, asking only the blockers added
 * before this one (a page further out may still have something to say).
 */
export type NavigationBlocker = (attempt: NavigationAttempt, proceed: () => void) => boolean;


export interface NavigationBlockers {
  /** Add a blocker on top; the function returned removes it, in whatever order. */
  add(blocker: NavigationBlocker): () => void;
  /**
   * Ask every blocker, newest first. True when one held it; that one was handed a `proceed`
   * that asks the ones under it and, when none of them holds, calls `carryOut`.
   */
  ask(attempt: NavigationAttempt, carryOut: () => void): boolean;
  /** Run `navigate` past every blocker: a redirect that must happen (an account taken away). */
  force(navigate: () => void): void;
  /**
   * The step by count last let through (`go` after Leave, or forced; or Back after Leave, from
   * `passNext`), taken once by `UrlScopeProvider`: the POP that step causes has been through the
   * blockers already. The provider drops it on anything else the history does, so a step that
   * went nowhere (no entry that far) lets nothing through later.
   */
  takePass(): number | null;
  passNext(delta: number): void;
}

const registries = new WeakMap<Navigator, NavigationBlockers>();

/** The blockers of `navigator`, wrapping it the first time it is asked for. */
export function navigationBlockers(navigator: Navigator): NavigationBlockers {
  let registry = registries.get(navigator);
  if (!registry) {
    registry = install(navigator);
    registries.set(navigator, registry);
  }
  return registry;
}

function install(navigator: Navigator): NavigationBlockers {
  const stack: NavigationBlocker[] = [];
  let forcing = 0;
  let pass: number | null = null;

  /** `consult` newest first, each still added; a holder's `proceed` asks the ones under it. */
  const askOf = (attempt: NavigationAttempt, consult: readonly NavigationBlocker[], carryOut: () => void): boolean => {
    for (let i = consult.length - 1; i >= 0; i -= 1) {
      const blocker = consult[i]!;
      if (!stack.includes(blocker)) continue;
      const proceed = () => {
        if (!askOf(attempt, consult.slice(0, i), carryOut)) carryOut();
      };
      if (blocker(attempt, proceed)) return true;
    }
    return false;
  };
  const ask: NavigationBlockers['ask'] = (attempt, carryOut) => askOf(attempt, [...stack], carryOut);

  const push = navigator.push.bind(navigator);
  const replace = navigator.replace.bind(navigator);
  const go = navigator.go.bind(navigator);

  const pathOf = (to: To): string | null => {
    const target = typeof to === 'string' ? parsePath(to) : to;
    return target.pathname ?? '';
  };

  navigator.push = (...args: Parameters<Navigator['push']>) => {
    if (forcing > 0 || !ask({ pathname: pathOf(args[0]) }, () => push(...args))) push(...args);
  };
  navigator.replace = (...args: Parameters<Navigator['replace']>) => {
    if (forcing > 0 || !ask({ pathname: pathOf(args[0]) }, () => replace(...args))) replace(...args);
  };
  const passedGo = (delta: number) => {
    pass = delta;
    go(delta);
  };
  navigator.go = (delta: number) => {
    if (forcing > 0 || !ask({ pathname: null }, () => passedGo(delta))) passedGo(delta);
  };

  return {
    add(blocker) {
      stack.push(blocker);
      return () => {
        const at = stack.indexOf(blocker);
        if (at >= 0) stack.splice(at, 1);
      };
    },
    ask,
    force(navigate) {
      forcing += 1;
      try {
        navigate();
      } finally {
        forcing -= 1;
      }
    },
    takePass() {
      const taken = pass;
      pass = null;
      return taken;
    },
    passNext(delta) {
      pass = delta;
    },
  };
}
