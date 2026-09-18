import { FormEvent, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './lib/supabase'

const SCHOOL_DOMAIN = '@lookool.ee'
const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString()

type Profile = {
  full_name: string | null
  role: 'teacher' | 'admin'
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setProfile(null)
      return
    }

    supabase
      .from('profiles')
      .select('full_name, role')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => setProfile(data as Profile | null))
  }, [session])

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')

    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail.endsWith(SCHOOL_DOMAIN)) {
      setError(`Kasuta kooli e-posti aadressi lõpuga ${SCHOOL_DOMAIN}.`)
      return
    }
    if (!supabase) {
      setError('Supabase’i ühendus pole veel seadistatud.')
      return
    }

    setSubmitting(true)
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: appUrl,
        shouldCreateUser: true,
      },
    })
    setSubmitting(false)

    if (authError) {
      setError('Sisselogimislinki ei õnnestunud saata. Proovi hetke pärast uuesti.')
      return
    }

    setMessage(`Saatsime sisselogimislingi aadressile ${normalizedEmail}.`)
  }

  async function signOut() {
    await supabase?.auth.signOut()
  }

  if (loading) {
    return <main className="center-page"><div className="loader" aria-label="Laen" /></main>
  }

  if (session) {
    const displayName = profile?.full_name || session.user.email?.split('@')[0] || 'õpetaja'
    return (
      <div className="app-shell">
        <header className="topbar">
          <a className="brand brand--small" href={import.meta.env.BASE_URL} aria-label="Avaleht">
            <span className="brand__mark">L</span>
            <span>Loo Kooli isteplaan</span>
          </a>
          <div className="account">
            <span>{displayName}</span>
            {profile?.role === 'admin' && <span className="badge">Admin</span>}
            <button className="button button--ghost" onClick={signOut}>Logi välja</button>
          </div>
        </header>
        <main className="dashboard">
          <section className="welcome-card">
            <div>
              <span className="eyebrow">Tere tulemast</span>
              <h1>Vali klass ja loo uus isteplaan.</h1>
              <p>Järgmises etapis tulevad siia sinu tärniga klassid, salvestatud plaanid ja uue isteplaani loomine.</p>
            </div>
            <button className="button" disabled>+ Uus isteplaan</button>
          </section>
          <section className="placeholder-grid" aria-label="Tulevased funktsioonid">
            <article><span>★</span><h2>Minu klassid</h2><p>Vali sagedamini kasutatavad klassid.</p></article>
            <article><span>▦</span><h2>Salvestatud plaanid</h2><p>Ava ja muuda varasemaid isteplaane.</p></article>
            <article><span>↗</span><h2>Ekspordi PDF</h2><p>Prindi selge klassiplaan koos tahvliga.</p></article>
          </section>
        </main>
      </div>
    )
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-copy">
          <a className="brand" href={import.meta.env.BASE_URL}>
            <span className="brand__mark">L</span>
            <span>Loo Kooli isteplaan</span>
          </a>
          <span className="eyebrow">Õpetajate töövahend</span>
          <h1>Paiguta klass rahulikult paika.</h1>
          <p>Koosta juhitud või juhuslik isteplaan, määra sobimatud naabrid ning salvesta plaan järgmiseks korraks.</p>
          <div className="feature-list">
            <span>✓ Klassid ja nimekirjad ühes kohas</span>
            <span>✓ Õpetaja enda privaatsed plaanid</span>
            <span>✓ Esitlusvaade ja PDF-eksport</span>
          </div>
        </div>

        <div className="login-form-wrap">
          <div className="login-form-header">
            <span className="icon-mail">✉</span>
            <h2>Logi sisse</h2>
            <p>Saadame sulle e-postiga ühekordse sisselogimislingi.</p>
          </div>

          {!isSupabaseConfigured && (
            <div className="notice notice--warning">Rakendus ootab veel Supabase’i publishable key seadistamist.</div>
          )}

          <form onSubmit={sendMagicLink}>
            <label htmlFor="email">Kooli e-post</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="eesnimi.perenimi@lookool.ee"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            {error && <div className="notice notice--error" role="alert">{error}</div>}
            {message && <div className="notice notice--success" role="status">{message}</div>}
            <button className="button button--wide" type="submit" disabled={submitting || !isSupabaseConfigured}>
              {submitting ? 'Saadan…' : 'Saada sisselogimislink'}
            </button>
          </form>
          <p className="privacy-note">Sisse saavad ainult <strong>@lookool.ee</strong> kasutajad. Õpilaste andmeid ei jagata väljapoole kooli.</p>
        </div>
      </section>
    </main>
  )
}

export default App
