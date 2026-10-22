import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { User } from './types'

/**
 * Session state. `loading` matters: the landing page must not flash a "Sign in"
 * CTA before /auth/me has answered, and guarded routes must not bounce to the
 * landing page while the cookie is still being checked.
 */
export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const r = await api.me()
      setUser(r.user as User)
      return r.user as User
    } catch {
      setUser(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const logout = useCallback(async () => {
    try { await api.logout() } finally { setUser(null) }
  }, [])

  return { user, loading, refresh, logout }
}

/**
 * Reveals [data-reveal] descendants as they scroll into view by stamping
 * [data-shown]. One observer for the whole subtree; elements are unobserved
 * after firing so nothing re-animates on scroll-back.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (targets.length === 0) return

    if (!('IntersectionObserver' in window)) {
      targets.forEach((el) => el.setAttribute('data-shown', ''))
      return
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement
          // Stagger siblings so a row of cards cascades instead of popping.
          const delay = Number(el.dataset.revealDelay ?? 0)
          window.setTimeout(() => el.setAttribute('data-shown', ''), delay)
          io.unobserve(el)
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    )
    targets.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  return ref
}

/** Interval that pauses itself when `active` is false. */
export function usePoll(fn: () => void, ms: number, active: boolean) {
  const saved = useRef(fn)
  // Written in an effect rather than during render so the interval always
  // calls the latest closure without the ref being touched mid-render.
  useEffect(() => { saved.current = fn }, [fn])

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => saved.current(), ms)
    return () => window.clearInterval(id)
  }, [ms, active])
}
