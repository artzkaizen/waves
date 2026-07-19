import { useEffect, useState } from 'react'

/** useState backed by localStorage (JSON-serialised). Falls back gracefully. */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof localStorage === 'undefined') return initial
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage unavailable — ignore */
    }
  }, [key, value])

  return [value, setValue] as const
}
