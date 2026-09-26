/** Names only: importing this policy never brings React or user evaluation into the compiler. */
export const TRUSTED_REACT_EXPORTS = [
  'useState', 'useEffect', 'useLayoutEffect', 'useRef', 'useMemo', 'useCallback',
  'useReducer', 'useContext', 'useId', 'useSyncExternalStore', 'createContext',
  'createElement', 'cloneElement', 'isValidElement', 'Fragment', 'Children', 'memo',
] as const;

export function isTrustedReactExport(name: string): boolean {
  return TRUSTED_REACT_EXPORTS.some(allowed => allowed === name);
}
