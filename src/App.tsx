import { FormEvent, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './lib/supabase'

const SCHOOL_DOMAIN = '@lookool.ee'
const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString()

type Profile = { display_name: string | null; role: 'teacher' | 'admin' }
type SchoolClass = { id: string; name: string; academic_year: string }
type Student = { id: string; class_id: string; first_name: string; last_name: string }
type EditableStudent = { id?: string; first_name: string; last_name: string }
type ViewFilter = 'favorites' | 'all'
type AdminMode = 'single' | 'import'

function parseStudentNames(value: string) {
  return value.split('\n').map((line) => line.trim().replace(/^[-•]\s*/, '')).filter(Boolean).map((fullName) => {
    const parts = fullName.split(/\s+/)
    return { first_name: parts.shift() || '', last_name: parts.join(' ') }
  }).filter((student) => student.first_name && student.last_name)
}

function parseCsvLine(line: string, separator: string) {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1 }
    else if (character === '"') quoted = !quoted
    else if (character === separator && !quoted) { cells.push(value.trim()); value = '' }
    else value += character
  }
  cells.push(value.trim())
  return cells
}

function parseClassCsv(content: string) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) throw new Error('Failis pole õpilaste ridu.')
  const candidates = [';', ',', '\t']
  const separator = candidates.sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0]
  const headers = parseCsvLine(lines[0], separator).map((header) => header.toLocaleLowerCase('et'))
  const required = ['klass', 'õppeaasta', 'eesnimi', 'perekonnanimi']
  const indexes = required.map((header) => headers.indexOf(header))
  if (indexes.some((index) => index < 0)) throw new Error('Failis peavad olema veerud: Klass, Õppeaasta, Eesnimi, Perekonnanimi.')
  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line, separator)
    const [classIndex, yearIndex, firstNameIndex, lastNameIndex] = indexes
    const row = { className: cells[classIndex]?.trim(), academicYear: cells[yearIndex]?.trim(), first_name: cells[firstNameIndex]?.trim(), last_name: cells[lastNameIndex]?.trim() }
    if (!row.className || !row.academicYear || !row.first_name || !row.last_name) throw new Error(`Rida ${rowIndex + 2} on poolik.`)
    return row
  })
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [classes, setClasses] = useState<SchoolClass[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())
  const [viewFilter, setViewFilter] = useState<ViewFilter>('favorites')
  const [search, setSearch] = useState('')
  const [selectedClass, setSelectedClass] = useState<SchoolClass | null>(null)
  const [showAdminForm, setShowAdminForm] = useState(false)
  const [editingClass, setEditingClass] = useState<SchoolClass | null>(null)
  const [editClassName, setEditClassName] = useState('')
  const [editAcademicYear, setEditAcademicYear] = useState('')
  const [editMembers, setEditMembers] = useState<EditableStudent[]>([])
  const [editError, setEditError] = useState('')
  const [savingEdits, setSavingEdits] = useState(false)
  const [adminMode, setAdminMode] = useState<AdminMode>('single')
  const [className, setClassName] = useState('')
  const [academicYear, setAcademicYear] = useState('2026/2027')
  const [studentNames, setStudentNames] = useState('')
  const [savingClass, setSavingClass] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [dashboardNotice, setDashboardNotice] = useState('')
  const [dashboardError, setDashboardError] = useState('')

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setProfile(null); setClasses([]); setStudents([]); setFavoriteIds(new Set()); return
    }
    async function loadDashboard() {
      if (!supabase || !session) return
      setDataLoading(true); setDashboardError('')
      const [profileResult, classesResult, studentsResult, favoritesResult] = await Promise.all([
        supabase.from('profiles').select('display_name, role').eq('id', session.user.id).single(),
        supabase.from('school_classes').select('id, name, academic_year').eq('archived', false).order('name'),
        supabase.from('students').select('id, class_id, first_name, last_name').eq('active', true).order('last_name'),
        supabase.from('teacher_favorite_classes').select('class_id').eq('teacher_id', session.user.id),
      ])
      if (profileResult.error || classesResult.error || studentsResult.error || favoritesResult.error) setDashboardError('Andmeid ei õnnestunud laadida. Värskenda lehte või proovi uuesti.')
      setProfile(profileResult.data as Profile | null)
      setClasses((classesResult.data || []) as SchoolClass[])
      setStudents((studentsResult.data || []) as Student[])
      setFavoriteIds(new Set((favoritesResult.data || []).map((favorite) => favorite.class_id)))
      setDataLoading(false)
    }
    loadDashboard()
  }, [session])

  const studentCountByClass = useMemo(() => students.reduce<Record<string, number>>((counts, student) => {
    counts[student.class_id] = (counts[student.class_id] || 0) + 1
    return counts
  }, {}), [students])

  const visibleClasses = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('et')
    return classes.filter((schoolClass) => (viewFilter === 'all' || favoriteIds.has(schoolClass.id)) && (!query || schoolClass.name.toLocaleLowerCase('et').includes(query)))
  }, [classes, favoriteIds, search, viewFilter])

  const selectedStudents = useMemo(() => selectedClass ? students.filter((student) => student.class_id === selectedClass.id).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'et')) : [], [selectedClass, students])

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage('')
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail.endsWith(SCHOOL_DOMAIN)) { setError(`Kasuta kooli e-posti aadressi lõpuga ${SCHOOL_DOMAIN}.`); return }
    if (!supabase) { setError('Supabase’i ühendus pole veel seadistatud.'); return }
    setSubmitting(true)
    const { error: authError } = await supabase.auth.signInWithOtp({ email: normalizedEmail, options: { emailRedirectTo: appUrl, shouldCreateUser: true } })
    setSubmitting(false)
    if (authError) { setError('Sisselogimislinki ei õnnestunud saata. Proovi hetke pärast uuesti.'); return }
    setMessage(`Saatsime sisselogimislingi aadressile ${normalizedEmail}.`)
  }

  async function toggleFavorite(classId: string) {
    if (!supabase || !session) return
    setDashboardError('')
    const isFavorite = favoriteIds.has(classId)
    setFavoriteIds((current) => { const next = new Set(current); isFavorite ? next.delete(classId) : next.add(classId); return next })
    const result = isFavorite
      ? await supabase.from('teacher_favorite_classes').delete().eq('teacher_id', session.user.id).eq('class_id', classId)
      : await supabase.from('teacher_favorite_classes').insert({ teacher_id: session.user.id, class_id: classId })
    if (result.error) {
      setFavoriteIds((current) => { const next = new Set(current); isFavorite ? next.add(classId) : next.delete(classId); return next })
      setDashboardError('Lemmikklassi muutmine ei õnnestunud.')
    }
  }

  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || profile?.role !== 'admin') return
    const parsedStudents = parseStudentNames(studentNames)
    const lineCount = studentNames.split('\n').filter((line) => line.trim()).length
    setDashboardError(''); setDashboardNotice('')
    if (!className.trim() || !academicYear.trim()) { setDashboardError('Sisesta klassi nimi ja õppeaasta.'); return }
    if (lineCount > 0 && parsedStudents.length !== lineCount) { setDashboardError('Igal õpilasereal peab olema vähemalt ees- ja perekonnanimi.'); return }
    setSavingClass(true)
    const classResult = await supabase.from('school_classes').insert({ name: className.trim(), academic_year: academicYear.trim() }).select('id, name, academic_year').single()
    if (classResult.error || !classResult.data) { setSavingClass(false); setDashboardError('Klassi lisamine ei õnnestunud. Kontrolli, kas sama klass on juba olemas.'); return }
    const newClass = classResult.data as SchoolClass
    if (parsedStudents.length) {
      const studentsResult = await supabase.from('students').insert(parsedStudents.map((student) => ({ ...student, class_id: newClass.id }))).select('id, class_id, first_name, last_name')
      if (studentsResult.error) {
        await supabase.from('school_classes').delete().eq('id', newClass.id)
        setSavingClass(false); setDashboardError('Õpilaste lisamine ei õnnestunud ja klassi ei salvestatud.'); return
      }
      setStudents((current) => [...current, ...((studentsResult.data || []) as Student[])])
    }
    setClasses((current) => [...current, newClass].sort((a, b) => a.name.localeCompare(b.name, 'et')))
    setClassName(''); setStudentNames(''); setSavingClass(false); setShowAdminForm(false); setViewFilter('all')
    setDashboardNotice(`Klass ${newClass.name} ja ${parsedStudents.length} õpilast on lisatud.`)
  }

  function downloadImportTemplate() {
    const csv = '\uFEFFKlass;Õppeaasta;Eesnimi;Perekonnanimi\n8.a;2026/2027;Mari;Maasikas\n8.a;2026/2027;Jüri;Kask\n8.b;2026/2027;Kati;Tamm\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'klasside_import_naidis.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function importClasses(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || profile?.role !== 'admin' || !importFile) return
    setDashboardError(''); setDashboardNotice(''); setSavingClass(true)
    try {
      const rows = parseClassCsv(await importFile.text())
      const classMap = new Map<string, { name: string; academic_year: string }>()
      rows.forEach((row) => classMap.set(`${row.academicYear}::${row.className.toLocaleLowerCase('et')}`, { name: row.className, academic_year: row.academicYear }))
      const classRecords = [...classMap.values()]
      const duplicate = classRecords.find((record) => classes.some((item) => item.name.toLocaleLowerCase('et') === record.name.toLocaleLowerCase('et') && item.academic_year === record.academic_year))
      if (duplicate) throw new Error(`Klass ${duplicate.name} (${duplicate.academic_year}) on juba olemas.`)

      const classesResult = await supabase.from('school_classes').insert(classRecords).select('id, name, academic_year')
      if (classesResult.error || !classesResult.data) throw new Error('Klasside salvestamine ei õnnestunud.')
      const createdClasses = classesResult.data as SchoolClass[]
      const idMap = new Map(createdClasses.map((item) => [`${item.academic_year}::${item.name.toLocaleLowerCase('et')}`, item.id]))
      const studentsResult = await supabase.from('students').insert(rows.map((row) => ({ class_id: idMap.get(`${row.academicYear}::${row.className.toLocaleLowerCase('et')}`), first_name: row.first_name, last_name: row.last_name }))).select('id, class_id, first_name, last_name')
      if (studentsResult.error) {
        await supabase.from('school_classes').delete().in('id', createdClasses.map((item) => item.id))
        throw new Error('Õpilaste salvestamine ei õnnestunud. Import tühistati.')
      }
      setClasses((current) => [...current, ...createdClasses].sort((a, b) => a.name.localeCompare(b.name, 'et')))
      setStudents((current) => [...current, ...((studentsResult.data || []) as Student[])])
      setImportFile(null); setSavingClass(false); setShowAdminForm(false); setViewFilter('all')
      setDashboardNotice(`Imporditud ${createdClasses.length} klassi ja ${rows.length} õpilast.`)
    } catch (importError) {
      setSavingClass(false)
      setDashboardError(importError instanceof Error ? importError.message : 'Faili importimine ei õnnestunud.')
    }
  }

  function openClassEditor(schoolClass: SchoolClass) {
    const members = students.filter((student) => student.class_id === schoolClass.id).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'et'))
    setEditClassName(schoolClass.name)
    setEditAcademicYear(schoolClass.academic_year)
    setEditMembers(members.map(({ id, first_name, last_name }) => ({ id, first_name, last_name })))
    setEditError('')
    setSelectedClass(null)
    setEditingClass(schoolClass)
  }

  function updateMember(index: number, field: 'first_name' | 'last_name', value: string) {
    setEditMembers((current) => current.map((member, memberIndex) => memberIndex === index ? { ...member, [field]: value } : member))
  }

  async function saveClassEdits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || profile?.role !== 'admin' || !editingClass) return
    const client = supabase
    setEditError('')
    if (!editClassName.trim() || !editAcademicYear.trim()) { setEditError('Klassi nimi ja õppeaasta on kohustuslikud.'); return }
    if (editMembers.some((member) => !member.first_name.trim() || !member.last_name.trim())) { setEditError('Igal õpilasel peab olema ees- ja perekonnanimi.'); return }
    setSavingEdits(true)

    const classResult = await client.from('school_classes').update({ name: editClassName.trim(), academic_year: editAcademicYear.trim() }).eq('id', editingClass.id)
    if (classResult.error) { setSavingEdits(false); setEditError('Klassi nime muutmine ei õnnestunud. Kontrolli, kas sama nimi on juba kasutusel.'); return }

    const originalIds = students.filter((student) => student.class_id === editingClass.id).map((student) => student.id)
    const retainedIds = new Set(editMembers.flatMap((member) => member.id ? [member.id] : []))
    const removedIds = originalIds.filter((id) => !retainedIds.has(id))
    const existingMembers = editMembers.filter((member): member is EditableStudent & { id: string } => Boolean(member.id))
    const newMembers = editMembers.filter((member) => !member.id)

    const memberOperations = await Promise.all([
      ...existingMembers.map((member) => client.from('students').update({ first_name: member.first_name.trim(), last_name: member.last_name.trim() }).eq('id', member.id).select('id, class_id, first_name, last_name').single()),
      ...(newMembers.length ? [client.from('students').insert(newMembers.map((member) => ({ class_id: editingClass.id, first_name: member.first_name.trim(), last_name: member.last_name.trim() }))).select('id, class_id, first_name, last_name')] : []),
      ...(removedIds.length ? [client.from('students').delete().in('id', removedIds)] : []),
    ])

    if (memberOperations.some((operation) => operation.error)) {
      setSavingEdits(false); setEditError('Kõiki õpilaste muudatusi ei õnnestunud salvestada. Värskenda lehte ja kontrolli nimekirja.'); return
    }

    const refreshedStudents = await client.from('students').select('id, class_id, first_name, last_name').eq('class_id', editingClass.id).eq('active', true).order('last_name')
    const updatedClass = { ...editingClass, name: editClassName.trim(), academic_year: editAcademicYear.trim() }
    setClasses((current) => current.map((item) => item.id === editingClass.id ? updatedClass : item).sort((a, b) => a.name.localeCompare(b.name, 'et')))
    setStudents((current) => [...current.filter((student) => student.class_id !== editingClass.id), ...((refreshedStudents.data || []) as Student[])])
    setSavingEdits(false); setEditingClass(null); setDashboardNotice(`Klassi ${updatedClass.name} muudatused on salvestatud.`)
  }

  async function signOut() { await supabase?.auth.signOut() }

  if (loading) return <main className="center-page"><div className="loader" aria-label="Laen" /></main>

  if (session) {
    const displayName = profile?.display_name || session.user.email?.split('@')[0] || 'õpetaja'
    return <div className="app-shell">
      <header className="topbar">
        <a className="brand brand--small" href={import.meta.env.BASE_URL} aria-label="Avaleht"><span className="brand__mark">L</span><span>Loo Kooli isteplaan</span></a>
        <div className="account"><span>{displayName}</span>{profile?.role === 'admin' && <span className="badge">Admin</span>}<button className="button button--ghost button--compact" onClick={signOut}>Logi välja</button></div>
      </header>
      <main className="dashboard">
        <section className="welcome-card">
          <div><span className="eyebrow">Klasside töölaud</span><h1>Vali klass ja loo uus isteplaan.</h1><p>Märgi sagedamini kasutatavad klassid tärniga. Õpilaste nimekirjad on nähtavad ainult sisselogitud koolitöötajatele.</p></div>
          {profile?.role === 'admin' && <button className="button button--gold" onClick={() => setShowAdminForm(true)}>+ Lisa klass</button>}
        </section>
        {(dashboardError || dashboardNotice) && <div className={`notice dashboard-notice ${dashboardError ? 'notice--error' : 'notice--success'}`} role="status">{dashboardError || dashboardNotice}</div>}
        <section className="class-section">
          <div className="section-heading">
            <div><span className="eyebrow">Klassid</span><h2>{viewFilter === 'favorites' ? 'Minu klassid' : 'Kõik klassid'}</h2></div>
            <div className="class-tools">
              <div className="segmented" aria-label="Klasside filter">
                <button className={viewFilter === 'favorites' ? 'active' : ''} onClick={() => setViewFilter('favorites')}>★ Minu klassid <span>{favoriteIds.size}</span></button>
                <button className={viewFilter === 'all' ? 'active' : ''} onClick={() => setViewFilter('all')}>Kõik <span>{classes.length}</span></button>
              </div>
              <input className="search-input" type="search" placeholder="Otsi klassi…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
          </div>
          {dataLoading ? <div className="data-state"><div className="loader" /><p>Laen klasse…</p></div> : visibleClasses.length ? <div className="class-grid">
            {visibleClasses.map((schoolClass) => {
              const isFavorite = favoriteIds.has(schoolClass.id)
              return <article className="class-card" key={schoolClass.id}>
                <button className={`favorite-button ${isFavorite ? 'favorite-button--active' : ''}`} onClick={() => toggleFavorite(schoolClass.id)} aria-label={isFavorite ? `Eemalda ${schoolClass.name} lemmikutest` : `Lisa ${schoolClass.name} lemmikuks`}>★</button>
                <button className="class-card__main" onClick={() => setSelectedClass(schoolClass)}><span className="class-icon">{schoolClass.name.slice(0, 2).toUpperCase()}</span><span className="class-card__copy"><strong>{schoolClass.name}</strong><span>{studentCountByClass[schoolClass.id] || 0} õpilast · {schoolClass.academic_year}</span></span><span className="arrow">→</span></button>
              </article>
            })}
          </div> : <div className="empty-state">
            <span>{viewFilter === 'favorites' ? '☆' : '▦'}</span><h3>{viewFilter === 'favorites' ? 'Sul pole veel lemmikklasse' : 'Klasse pole veel lisatud'}</h3>
            <p>{viewFilter === 'favorites' ? 'Ava „Kõik“ ja vajuta vajalike klasside juures tärnile.' : profile?.role === 'admin' ? 'Lisa esimene klass ja kleebi õpilaste nimed nimekirjana.' : 'Administraator pole veel klassinimekirju lisanud.'}</p>
            {viewFilter === 'favorites' && classes.length > 0 && <button className="button button--ghost" onClick={() => setViewFilter('all')}>Vaata kõiki klasse</button>}
            {viewFilter === 'all' && profile?.role === 'admin' && <button className="button" onClick={() => setShowAdminForm(true)}>+ Lisa esimene klass</button>}
          </div>}
        </section>
      </main>

      {selectedClass && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedClass(null)}><section className="modal roster-modal" role="dialog" aria-modal="true" aria-labelledby="roster-title">
        <div className="modal-header"><div><span className="eyebrow">{selectedClass.academic_year}</span><h2 id="roster-title">{selectedClass.name}</h2><p>{selectedStudents.length} õpilast</p></div><button className="icon-button" onClick={() => setSelectedClass(null)} aria-label="Sulge">×</button></div>
        {selectedStudents.length ? <ol className="student-list">{selectedStudents.map((student) => <li key={student.id}><span>{student.first_name} {student.last_name}</span></li>)}</ol> : <div className="mini-empty">Selles klassis pole veel õpilasi.</div>}
        <div className="modal-actions">{profile?.role === 'admin' && <button className="button button--ghost button--edit" onClick={() => openClassEditor(selectedClass)}>Muuda klassi</button>}<button className="button button--ghost" onClick={() => setSelectedClass(null)}>Sulge</button><button className="button" disabled>Koosta isteplaan →</button></div><p className="coming-soon">Isteplaani koostamine lisandub järgmises etapis.</p>
      </section></div>}

      {editingClass && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setEditingClass(null)}><section className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="edit-class-title">
        <div className="modal-header"><div><span className="eyebrow">Administraator</span><h2 id="edit-class-title">Muuda klassi</h2><p>Paranda klassi andmeid ja õpilaste nimekirja.</p></div><button className="icon-button" onClick={() => setEditingClass(null)} aria-label="Sulge">×</button></div>
        <form onSubmit={saveClassEdits}>
          <div className="field-row"><div className="field"><label htmlFor="edit-class-name">Klassi nimi</label><input id="edit-class-name" value={editClassName} onChange={(event) => setEditClassName(event.target.value)} required /></div><div className="field"><label htmlFor="edit-academic-year">Õppeaasta</label><input id="edit-academic-year" value={editAcademicYear} onChange={(event) => setEditAcademicYear(event.target.value)} required /></div></div>
          <div className="member-editor-header"><div><strong>Õpilased</strong><span>{editMembers.length} nimekirjas</span></div><button className="template-button" type="button" onClick={() => setEditMembers((current) => [...current, { first_name: '', last_name: '' }])}>+ Lisa õpilane</button></div>
          <div className="member-editor">{editMembers.map((member, index) => <div className="member-row" key={member.id || `new-${index}`}><span>{index + 1}</span><input aria-label={`Õpilase ${index + 1} eesnimi`} value={member.first_name} onChange={(event) => updateMember(index, 'first_name', event.target.value)} placeholder="Eesnimi" required /><input aria-label={`Õpilase ${index + 1} perekonnanimi`} value={member.last_name} onChange={(event) => updateMember(index, 'last_name', event.target.value)} placeholder="Perekonnanimi" required /><button type="button" onClick={() => setEditMembers((current) => current.filter((_, memberIndex) => memberIndex !== index))} aria-label={`Eemalda ${member.first_name} ${member.last_name}`}>×</button></div>)}</div>
          {editError && <div className="notice notice--error" role="alert">{editError}</div>}
          <div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setEditingClass(null)}>Loobu</button><button className="button" type="submit" disabled={savingEdits}>{savingEdits ? 'Salvestan…' : 'Salvesta muudatused'}</button></div>
        </form>
      </section></div>}

      {showAdminForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowAdminForm(false)}><section className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <div className="modal-header"><div><span className="eyebrow">Administraator</span><h2 id="admin-title">Lisa klassid</h2><p>Lisa üks klass käsitsi või impordi kõik nimekirjad Excelist.</p></div><button className="icon-button" onClick={() => setShowAdminForm(false)} aria-label="Sulge">×</button></div>
        <div className="admin-tabs"><button className={adminMode === 'single' ? 'active' : ''} onClick={() => setAdminMode('single')}>Üks klass</button><button className={adminMode === 'import' ? 'active' : ''} onClick={() => setAdminMode('import')}>Exceli import</button></div>
        {adminMode === 'single' ? <form onSubmit={createClass}><div className="field-row"><div className="field"><label htmlFor="class-name">Klassi nimi</label><input id="class-name" value={className} onChange={(event) => setClassName(event.target.value)} placeholder="Näiteks 8.a" required /></div><div className="field"><label htmlFor="academic-year">Õppeaasta</label><input id="academic-year" value={academicYear} onChange={(event) => setAcademicYear(event.target.value)} placeholder="2026/2027" required /></div></div>
          <div className="field"><label htmlFor="student-names">Õpilaste nimed</label><textarea id="student-names" value={studentNames} onChange={(event) => setStudentNames(event.target.value)} placeholder={'Mari Maasikas\nJüri Kask\nKati Tamm'} rows={11} /><small>{parseStudentNames(studentNames).length} korrektset nime · vähemalt ees- ja perekonnanimi</small></div>
          <div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setShowAdminForm(false)}>Loobu</button><button className="button" type="submit" disabled={savingClass}>{savingClass ? 'Salvestan…' : 'Salvesta klass'}</button></div>
        </form> : <form onSubmit={importClasses}><div className="import-guide"><strong>Faili veerud</strong><span>Klass</span><span>Õppeaasta</span><span>Eesnimi</span><span>Perekonnanimi</span></div><p className="import-help">Täida näidisfail Excelis ja salvesta vormingus <strong>CSV UTF-8</strong>. Fail võib sisaldada korraga kõiki kooli klasse.</p><div className="file-drop"><input id="class-file" type="file" accept=".csv,text/csv" onChange={(event) => setImportFile(event.target.files?.[0] || null)} required /><label htmlFor="class-file"><span>↑</span><strong>{importFile?.name || 'Vali CSV-fail'}</strong><small>{importFile ? 'Fail on importimiseks valmis' : 'CSV UTF-8, kuni kõik kooli klassid korraga'}</small></label></div><button className="template-button" type="button" onClick={downloadImportTemplate}>↓ Laadi alla Exceli näidisfail</button><div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setShowAdminForm(false)}>Loobu</button><button className="button" type="submit" disabled={savingClass || !importFile}>{savingClass ? 'Impordin…' : 'Impordi klassid'}</button></div></form>}
      </section></div>}
    </div>
  }

  return <main className="login-page"><section className="login-card">
    <div className="login-copy"><a className="brand" href={import.meta.env.BASE_URL}><span className="brand__mark">L</span><span>Loo Kooli isteplaan</span></a><span className="eyebrow">Õpetajate töövahend</span><h1>Paiguta klass rahulikult paika.</h1><p>Koosta juhitud või juhuslik isteplaan, määra sobimatud naabrid ning salvesta plaan järgmiseks korraks.</p><div className="feature-list"><span>✓ Klassid ja nimekirjad ühes kohas</span><span>✓ Õpetaja enda privaatsed plaanid</span><span>✓ Esitlusvaade ja PDF-eksport</span></div></div>
    <div className="login-form-wrap"><div className="login-form-header"><span className="icon-mail">✉</span><h2>Logi sisse</h2><p>Saadame sulle e-postiga ühekordse sisselogimislingi.</p></div>
      {!isSupabaseConfigured && <div className="notice notice--warning">Rakendus ootab veel Supabase’i publishable key seadistamist.</div>}
      <form onSubmit={sendMagicLink}><label htmlFor="email">Kooli e-post</label><input id="email" name="email" type="email" autoComplete="email" placeholder="eesnimi.perenimi@lookool.ee" value={email} onChange={(event) => setEmail(event.target.value)} required />{error && <div className="notice notice--error" role="alert">{error}</div>}{message && <div className="notice notice--success" role="status">{message}</div>}<button className="button button--wide" type="submit" disabled={submitting || !isSupabaseConfigured}>{submitting ? 'Saadan…' : 'Saada sisselogimislink'}</button></form>
      <p className="privacy-note">Sisse saavad ainult <strong>@lookool.ee</strong> kasutajad. Õpilaste andmeid ei jagata väljapoole kooli.</p>
    </div>
  </section></main>
}

export default App
