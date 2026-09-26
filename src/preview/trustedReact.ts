// Frame-only runtime. Do not import this module from the parent compiler.
import {
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer,
  useContext, useId, useSyncExternalStore, createContext, createElement,
  cloneElement, isValidElement, Fragment, Children, memo,
} from 'react';
import type { TRUSTED_REACT_EXPORTS } from '../features/document/trustedReactImports';

export const trustedReact = Object.freeze({
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer,
  useContext, useId, useSyncExternalStore, createContext, createElement,
  cloneElement, isValidElement, Fragment, Children, memo,
} satisfies Record<typeof TRUSTED_REACT_EXPORTS[number], unknown>);
