import { FormEvent, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './lib/supabase'

const SCHOOL_DOMAIN = '@lookool.ee'
const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString()
const logoUrl = `${import.meta.env.BASE_URL}assets/loo-kooli-logo.png`
const classNameCollator = new Intl.Collator('et', { numeric: true, sensitivity: 'base' })

type Profile = { display_name: string | null; role: 'teacher' | 'admin' }
type SchoolClass = { id: string; name: string; academic_year: string; archived: boolean }
type Student = { id: string; class_id: string; first_name: string; last_name: string }
type TeachingGroup = { id: string; teacher_id: string; name: string; updated_at: string }
type TeachingGroupMember = { group_id: string; student_id: string }
type DashboardView = 'classes' | 'teaching-groups'
type EditableStudent = { id?: string; first_name: string; last_name: string }
type ViewFilter = 'favorites' | 'all'
type AdminMode = 'single' | 'import'
type DeskType = 'single' | 'pair' | 'mixed'
type DrawMode = 'random' | 'guided'
type ActivityType = 'seating' | 'groups'
type SeparationRule = { firstId: string; secondId: string; setId?: string }
type StoredSeat = { student_id: string | null; disabled?: boolean; group?: number; solo?: boolean; desk_size?: number }
type SeatingPlan = { id: string; class_id: string | null; teaching_group_id: string | null; name: string; rows: number; cols: number; seat_type: DeskType; mode: DrawMode; seats: StoredSeat[]; avoid_pairs: SeparationRule[]; activity_type: ActivityType; group_size: number | null; absent_students: string[]; updated_at: string }
type AdminUser = { user_id: string; email: string; display_name: string | null; role: 'teacher' | 'admin'; active: boolean; joined_at: string; last_seen_at: string | null; favorite_classes: string[]; saved_classes: string[]; plan_count: number }

function shuffle<T>(items: T[]) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function deskPosition(seatIndex: number, columns: number, seatsPerDesk: number) {
  const deskIndex = Math.floor(seatIndex / seatsPerDesk)
  return { row: Math.floor(deskIndex / columns), column: deskIndex % columns }
}

function violatesSeparation(assignments: (string | null)[], rules: SeparationRule[], columns: number, seatsPerDesk: number) {
  return rules.some((rule) => {
    const firstIndex = assignments.indexOf(rule.firstId)
    const secondIndex = assignments.indexOf(rule.secondId)
    if (firstIndex < 0 || secondIndex < 0) return false
    const first = deskPosition(firstIndex, columns, seatsPerDesk)
    const second = deskPosition(secondIndex, columns, seatsPerDesk)
    return Math.abs(first.row - second.row) + Math.abs(first.column - second.column) <= 1
  })
}

function makeGroupSizes(studentCount: number, targetSize: number) {
  if (!studentCount) return []
  if (studentCount <= targetSize) return [studentCount]
  const fullGroups = Math.floor(studentCount / targetSize)
  const remainder = studentCount % targetSize
  if (!remainder) return Array(fullGroups).fill(targetSize)
  if (remainder === 1 && fullGroups > 0) {
    if (targetSize === 2) return [...Array(Math.max(0, fullGroups - 1)).fill(2), 3]
    return [...Array(Math.max(0, fullGroups - 1)).fill(targetSize), targetSize - 1, 2]
  }
  return [...Array(fullGroups).fill(targetSize), remainder]
}

function groupsViolateRules(groups: string[][], rules: SeparationRule[]) {
  return rules.some((rule) => groups.some((group) => group.includes(rule.firstId) && group.includes(rule.secondId)))
}

function addToSmallestAllowedGroup(groups: string[][], studentId: string, rules: SeparationRule[]) {
  const next = groups.map((group) => [...group])
  const forbiddenIds = new Set(rules.flatMap((rule) => rule.firstId === studentId ? [rule.secondId] : rule.secondId === studentId ? [rule.firstId] : []))
  const target = next.filter((group) => !group.some((id) => forbiddenIds.has(id))).sort((first, second) => first.length - second.length)[0]
  if (target) target.push(studentId)
  else next.push([studentId])
  return next
}

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
  const [savedPlans, setSavedPlans] = useState<SeatingPlan[]>([])
  const [teachingGroups, setTeachingGroups] = useState<TeachingGroup[]>([])
  const [teachingGroupMembers, setTeachingGroupMembers] = useState<TeachingGroupMember[]>([])
  const [dashboardView, setDashboardView] = useState<DashboardView>('classes')
  const [selectedTeachingGroup, setSelectedTeachingGroup] = useState<TeachingGroup | null>(null)
  const [showTeachingGroupForm, setShowTeachingGroupForm] = useState(false)
  const [editingTeachingGroup, setEditingTeachingGroup] = useState<TeachingGroup | null>(null)
  const [teachingGroupName, setTeachingGroupName] = useState('')
  const [teachingGroupClassIds, setTeachingGroupClassIds] = useState<Set<string>>(new Set())
  const [teachingGroupStudentIds, setTeachingGroupStudentIds] = useState<Set<string>>(new Set())
  const [teachingGroupSearch, setTeachingGroupSearch] = useState('')
  const [savingTeachingGroup, setSavingTeachingGroup] = useState(false)
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
  const [plannerClass, setPlannerClass] = useState<SchoolClass | null>(null)
  const [plannerTeachingGroup, setPlannerTeachingGroup] = useState<TeachingGroup | null>(null)
  const [deskType, setDeskType] = useState<DeskType>('pair')
  const [deskRows, setDeskRows] = useState(4)
  const [deskColumns, setDeskColumns] = useState(3)
  const [disabledDesks, setDisabledDesks] = useState<Set<number>>(new Set())
  const [deskCapacities, setDeskCapacities] = useState<number[]>(Array(12).fill(2))
  const [drawMode, setDrawMode] = useState<DrawMode>('guided')
  const [activityType, setActivityType] = useState<ActivityType>('seating')
  const [groupSize, setGroupSize] = useState(4)
  const [groups, setGroups] = useState<string[][]>([])
  const [groupRuleSelection, setGroupRuleSelection] = useState<Set<string>>(new Set())
  const [groupRuleSearch, setGroupRuleSearch] = useState('')
  const [draggedGroupMember, setDraggedGroupMember] = useState<{ studentId: string; fromGroup: number } | null>(null)
  const [absentStudentIds, setAbsentStudentIds] = useState<Set<string>>(new Set())
  const [absenceSearch, setAbsenceSearch] = useState('')
  const [soloStudentIds, setSoloStudentIds] = useState<Set<string>>(new Set())
  const [soloSearch, setSoloSearch] = useState('')
  const [showAbsences, setShowAbsences] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<SeatingPlan | null>(null)
  const [assignments, setAssignments] = useState<(string | null)[]>([])
  const [lockedStudents, setLockedStudents] = useState<Set<string>>(new Set())
  const [separationRules, setSeparationRules] = useState<SeparationRule[]>([])
  const [ruleFirst, setRuleFirst] = useState('')
  const [ruleSecond, setRuleSecond] = useState('')
  const [plannerError, setPlannerError] = useState('')
  const [draggedSeat, setDraggedSeat] = useState<number | null>(null)
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [planName, setPlanName] = useState('')
  const [savingPlan, setSavingPlan] = useState(false)
  const [presentationMode, setPresentationMode] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [revealCount, setRevealCount] = useState(0)
  const [animationTick, setAnimationTick] = useState(0)
  const [showUsers, setShowUsers] = useState(false)
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [showArchive, setShowArchive] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [helpSection, setHelpSection] = useState<ActivityType>('seating')
  const [showProfile, setShowProfile] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [profileError, setProfileError] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
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
      setProfile(null); setClasses([]); setStudents([]); setFavoriteIds(new Set()); setSavedPlans([]); setTeachingGroups([]); setTeachingGroupMembers([]); return
    }
    async function loadDashboard() {
      if (!supabase || !session) return
      setDataLoading(true); setDashboardError('')
      const [profileResult, classesResult, studentsResult, favoritesResult, plansResult, groupsResult, groupMembersResult] = await Promise.all([
        supabase.from('profiles').select('display_name, role').eq('id', session.user.id).single(),
        supabase.from('school_classes').select('id, name, academic_year, archived').order('name'),
        supabase.from('students').select('id, class_id, first_name, last_name').eq('active', true).order('last_name'),
        supabase.from('teacher_favorite_classes').select('class_id').eq('teacher_id', session.user.id),
        supabase.from('seating_plans').select('id, class_id, teaching_group_id, name, rows, cols, seat_type, mode, seats, avoid_pairs, activity_type, group_size, absent_students, updated_at').eq('teacher_id', session.user.id).order('updated_at', { ascending: false }),
        supabase.from('teaching_groups').select('id, teacher_id, name, updated_at').eq('teacher_id', session.user.id).order('name'),
        supabase.from('teaching_group_students').select('group_id, student_id'),
      ])
      if (profileResult.error || classesResult.error || studentsResult.error || favoritesResult.error || plansResult.error || groupsResult.error || groupMembersResult.error) setDashboardError('Andmeid ei õnnestunud laadida. Värskenda lehte või proovi uuesti.')
      setProfile(profileResult.data as Profile | null)
      setClasses((classesResult.data || []) as SchoolClass[])
      setStudents((studentsResult.data || []) as Student[])
      setFavoriteIds(new Set((favoritesResult.data || []).map((favorite) => favorite.class_id)))
      setSavedPlans((plansResult.data || []) as SeatingPlan[])
      setTeachingGroups((groupsResult.data || []) as TeachingGroup[])
      setTeachingGroupMembers((groupMembersResult.data || []) as TeachingGroupMember[])
      setDataLoading(false)
    }
    loadDashboard()
  }, [session])

  useEffect(() => {
    if (supabase && session?.user.id) supabase.rpc('touch_last_seen').then(() => undefined)
  }, [session?.user.id])

  const studentCountByClass = useMemo(() => students.reduce<Record<string, number>>((counts, student) => {
    counts[student.class_id] = (counts[student.class_id] || 0) + 1
    return counts
  }, {}), [students])

  const activeClasses = useMemo(() => classes.filter((schoolClass) => !schoolClass.archived).sort((first, second) => classNameCollator.compare(first.name, second.name)), [classes])
  const archivedClasses = useMemo(() => classes.filter((schoolClass) => schoolClass.archived).sort((first, second) => classNameCollator.compare(first.name, second.name)), [classes])

  const visibleClasses = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('et')
    return activeClasses.filter((schoolClass) => (viewFilter === 'all' || favoriteIds.has(schoolClass.id)) && (!query || schoolClass.name.toLocaleLowerCase('et').includes(query)))
  }, [activeClasses, favoriteIds, search, viewFilter])

  const filteredAdminUsers = useMemo(() => {
    const query = userSearch.trim().toLocaleLowerCase('et')
    return adminUsers.filter((user) => !query || `${user.display_name || ''} ${user.email}`.toLocaleLowerCase('et').includes(query))
  }, [adminUsers, userSearch])

  const selectedStudents = useMemo(() => selectedClass ? students.filter((student) => student.class_id === selectedClass.id).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'et')) : [], [selectedClass, students])
  const selectedTeachingGroupStudents = useMemo(() => selectedTeachingGroup ? students.filter((student) => teachingGroupMembers.some((member) => member.group_id === selectedTeachingGroup.id && member.student_id === student.id)).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'et')) : [], [selectedTeachingGroup, students, teachingGroupMembers])
  const teachingGroupCandidateStudents = useMemo(() => {
    const query = teachingGroupSearch.trim().toLocaleLowerCase('et')
    return students.filter((student) => teachingGroupClassIds.has(student.class_id) && (!query || `${student.first_name} ${student.last_name}`.toLocaleLowerCase('et').includes(query))).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'et'))
  }, [students, teachingGroupClassIds, teachingGroupSearch])

  const plannerStudents = useMemo(() => plannerTeachingGroup
    ? students.filter((student) => teachingGroupMembers.some((member) => member.group_id === plannerTeachingGroup.id && member.student_id === student.id)).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'et'))
    : plannerClass ? students.filter((student) => student.class_id === plannerClass.id).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'et')) : [], [plannerClass, plannerTeachingGroup, students, teachingGroupMembers])
  const filteredAbsenceStudents = useMemo(() => {
    const query = absenceSearch.trim().toLocaleLowerCase('et')
    return plannerStudents.filter((student) => !query || `${student.first_name} ${student.last_name}`.toLocaleLowerCase('et').includes(query))
  }, [absenceSearch, plannerStudents])
  const filteredSoloStudents = useMemo(() => {
    const query = soloSearch.trim().toLocaleLowerCase('et')
    return plannerStudents.filter((student) => !absentStudentIds.has(student.id) && (!query || `${student.first_name} ${student.last_name}`.toLocaleLowerCase('et').includes(query)))
  }, [absentStudentIds, plannerStudents, soloSearch])
  const filteredGroupRuleStudents = useMemo(() => {
    const query = groupRuleSearch.trim().toLocaleLowerCase('et')
    return plannerStudents.filter((student) => !absentStudentIds.has(student.id) && (!query || `${student.first_name} ${student.last_name}`.toLocaleLowerCase('et').includes(query)))
  }, [absentStudentIds, groupRuleSearch, plannerStudents])
  const groupRestrictionSets = useMemo(() => {
    const grouped = new Map<string, Set<string>>()
    separationRules.forEach((rule, index) => {
      const key = rule.setId || `pair-${index}`
      if (!grouped.has(key)) grouped.set(key, new Set())
      grouped.get(key)!.add(rule.firstId); grouped.get(key)!.add(rule.secondId)
    })
    return [...grouped.entries()].map(([id, members]) => ({ id, members: [...members] }))
  }, [separationRules])
  const studentById = useMemo(() => new Map(plannerStudents.map((student) => [student.id, student])), [plannerStudents])
  const seatsPerDesk = deskType === 'mixed' ? 3 : deskType === 'pair' ? 2 : 1
  const totalDeskCount = deskRows * deskColumns
  const totalSeatSlots = totalDeskCount * seatsPerDesk
  const capacityForDesk = (deskIndex: number) => deskType === 'mixed' ? (deskCapacities[deskIndex] || 2) : seatsPerDesk
  const seatCount = Array.from({ length: totalDeskCount }, (_, deskIndex) => disabledDesks.has(deskIndex) ? 0 : capacityForDesk(deskIndex)).reduce((sum, capacity) => sum + capacity, 0)
  const planGenerated = assignments.length === totalSeatSlots
  const resultGenerated = activityType === 'groups' ? groups.length > 0 : planGenerated
  const revealOrder = useMemo(() => Array.from({ length: totalSeatSlots }, (_, index) => index)
    .filter((index) => {
      const deskIndex = Math.floor(index / seatsPerDesk)
      return !disabledDesks.has(deskIndex) && index % seatsPerDesk < capacityForDesk(deskIndex) && assignments[index]
    })
    .sort((first, second) => {
      const firstDesk = Math.floor(first / seatsPerDesk)
      const secondDesk = Math.floor(second / seatsPerDesk)
      const rowDifference = Math.floor(secondDesk / deskColumns) - Math.floor(firstDesk / deskColumns)
      return rowDifference || firstDesk - secondDesk || first - second
    }), [assignments, deskCapacities, deskColumns, deskType, disabledDesks, seatsPerDesk, totalSeatSlots])
  const presentationItemCount = activityType === 'groups' ? groups.flat().length : revealOrder.length

  useEffect(() => {
    if (!drawing) return
    const ticker = window.setInterval(() => setAnimationTick((current) => current + 1), 110)
    const revealer = window.setInterval(() => setRevealCount((current) => {
      if (current >= presentationItemCount - 1) { window.clearInterval(revealer); setDrawing(false); return presentationItemCount }
      return current + 1
    }), 430)
    return () => { window.clearInterval(ticker); window.clearInterval(revealer) }
  }, [drawing, presentationItemCount])

  function openPlanner(schoolClass: SchoolClass) {
    setSelectedClass(null)
    setSelectedTeachingGroup(null); setPlannerTeachingGroup(null)
    setPlannerClass(schoolClass)
    setDeskType('pair'); setDeskRows(4); setDeskColumns(3); setDisabledDesks(new Set()); setDeskCapacities(Array(12).fill(2)); setDrawMode('guided'); setActivityType('seating'); setGroupSize(4); setGroups([]); setGroupRuleSelection(new Set()); setGroupRuleSearch(''); setDraggedGroupMember(null); setAbsentStudentIds(new Set()); setAbsenceSearch(''); setSoloStudentIds(new Set()); setSoloSearch('')
    setAssignments([]); setLockedStudents(new Set()); setSeparationRules([]); setRuleFirst(''); setRuleSecond(''); setPlannerError(''); setEditingPlanId(null); setPlanName(`${schoolClass.name} isteplaan`)
  }

  function openTeachingGroupPlanner(group: TeachingGroup) {
    setSelectedTeachingGroup(null); setSelectedClass(null); setPlannerTeachingGroup(group)
    setPlannerClass({ id: group.id, name: group.name, academic_year: 'Õpperühm', archived: false })
    setDeskType('pair'); setDeskRows(4); setDeskColumns(3); setDisabledDesks(new Set()); setDeskCapacities(Array(12).fill(2)); setDrawMode('guided'); setActivityType('seating'); setGroupSize(4); setGroups([]); setAbsentStudentIds(new Set())
    setAssignments([]); setLockedStudents(new Set()); setSeparationRules([]); setRuleFirst(''); setRuleSecond(''); setPlannerError(''); setEditingPlanId(null); setPlanName(`${group.name} isteplaan`)
  }

  function openSavedPlan(plan: SeatingPlan, showPresentation = false) {
    if ((plan.absent_students || []).length) {
      setPendingPlan(plan); setAbsentStudentIds(new Set(plan.absent_students)); setShowAbsences(true); setSelectedClass(null); return
    }
    applySavedPlan(plan, showPresentation, new Set())
  }

  function applySavedPlan(plan: SeatingPlan, showPresentation = false, absences = new Set<string>()) {
    const teachingGroup = plan.teaching_group_id ? teachingGroups.find((item) => item.id === plan.teaching_group_id) || null : null
    const schoolClass = teachingGroup ? { id: teachingGroup.id, name: teachingGroup.name, academic_year: 'Õpperühm', archived: false } : classes.find((item) => item.id === plan.class_id)
    if (!schoolClass) return
    const seatMultiplier = plan.seat_type === 'mixed' ? 3 : plan.seat_type === 'pair' ? 2 : 1
    const nextActivity = plan.activity_type || 'seating'
    const loadedDeskCapacities = Array.from({ length: plan.rows * plan.cols }, (_, deskIndex) => plan.seat_type === 'mixed' ? Math.max(1, Math.min(3, plan.seats[deskIndex * 3]?.desk_size || 2)) : seatMultiplier)
    setSelectedClass(null); setSelectedTeachingGroup(null); setPlannerTeachingGroup(teachingGroup); setPlannerClass(schoolClass); setDeskRows(plan.rows); setDeskColumns(plan.cols); setDeskType(plan.seat_type); setDrawMode(plan.mode); setActivityType(nextActivity); setGroupSize(plan.group_size || 4); setAbsentStudentIds(absences)
    setDeskCapacities(loadedDeskCapacities)
    if (nextActivity === 'seating') {
      const loadedAssignments = plan.seats.map((seat) => seat.student_id || null)
      const returningIds = (plan.absent_students || []).filter((id) => !absences.has(id))
      const freeIndexes = loadedAssignments.map((value, index) => !value && !plan.seats[index]?.disabled && index % seatMultiplier < loadedDeskCapacities[Math.floor(index / seatMultiplier)] ? index : -1).filter((index) => index >= 0).sort((a, b) => b - a)
      returningIds.forEach((id, index) => { if (freeIndexes[index] !== undefined) loadedAssignments[freeIndexes[index]] = id })
      setAssignments(loadedAssignments)
      setSoloStudentIds(new Set(plan.seats.filter((seat) => seat.student_id && seat.solo).map((seat) => seat.student_id as string)))
    } else setAssignments([])
    if (nextActivity === 'groups') {
      const scopeStudentIds = teachingGroup ? new Set(teachingGroupMembers.filter((member) => member.group_id === teachingGroup.id).map((member) => member.student_id)) : null
      const presentIds = students.filter((student) => (scopeStudentIds ? scopeStudentIds.has(student.id) : student.class_id === plan.class_id) && !absences.has(student.id)).map((student) => student.id)
      const savedGroups = plan.seats.reduce<string[][]>((result, seat) => {
        if (!seat.student_id || absences.has(seat.student_id)) return result
        const groupIndex = seat.group ?? 0
        if (!result[groupIndex]) result[groupIndex] = []
        result[groupIndex].push(seat.student_id)
        return result
      }, []).filter(Boolean)
      const assigned = new Set(savedGroups.flat())
      let restoredGroups = savedGroups
      presentIds.filter((id) => !assigned.has(id)).forEach((id) => { restoredGroups = addToSmallestAllowedGroup(restoredGroups, id, plan.avoid_pairs || []) })
      setGroups(restoredGroups)
      setSoloStudentIds(new Set())
    } else setGroups([])
    setDisabledDesks(new Set(plan.seats.flatMap((seat, index) => seat.disabled ? [Math.floor(index / seatMultiplier)] : [])))
    setSeparationRules(plan.avoid_pairs || []); setLockedStudents(new Set()); setEditingPlanId(plan.id); setPlanName(plan.name); setPlannerError('')
    setPresentationMode(showPresentation); setRevealCount(0); setDrawing(false)
  }

  async function savePlan() {
    if (!supabase || !session || !plannerClass || !resultGenerated) return
    if (!planName.trim()) { setPlannerError('Pane isteplaanile nimi.'); return }
    setSavingPlan(true); setPlannerError('')
    const payload = {
      teacher_id: session.user.id, class_id: plannerTeachingGroup ? null : plannerClass.id, teaching_group_id: plannerTeachingGroup?.id || null, name: planName.trim(), rows: deskRows, cols: deskColumns,
      seat_type: deskType, mode: drawMode, activity_type: activityType, group_size: activityType === 'groups' ? groupSize : null,
      seats: activityType === 'groups' ? groups.flatMap((group, groupIndex) => group.map((studentId) => ({ student_id: studentId, group: groupIndex }))) : assignments.map((studentId, index) => ({ student_id: studentId, disabled: disabledDesks.has(Math.floor(index / seatsPerDesk)), solo: Boolean(studentId && soloStudentIds.has(studentId)), desk_size: capacityForDesk(Math.floor(index / seatsPerDesk)) })),
      avoid_pairs: separationRules, absent_students: [...absentStudentIds],
    }
    const result = editingPlanId
      ? await supabase.from('seating_plans').update(payload).eq('id', editingPlanId).select('id, class_id, teaching_group_id, name, rows, cols, seat_type, mode, seats, avoid_pairs, activity_type, group_size, absent_students, updated_at').single()
      : await supabase.from('seating_plans').insert(payload).select('id, class_id, teaching_group_id, name, rows, cols, seat_type, mode, seats, avoid_pairs, activity_type, group_size, absent_students, updated_at').single()
    setSavingPlan(false)
    if (result.error || !result.data) { setPlannerError('Isteplaani salvestamine ei õnnestunud. Proovi uuesti.'); return }
    const saved = result.data as SeatingPlan
    setEditingPlanId(saved.id)
    setSavedPlans((current) => [saved, ...current.filter((plan) => plan.id !== saved.id)])
    setDashboardNotice(`Isteplaan „${saved.name}“ on salvestatud.`)
  }

  async function copyPlan(plan: SeatingPlan) {
    if (!supabase || !session) return
    setDashboardError('')
    const result = await supabase.from('seating_plans').insert({
      teacher_id: session.user.id, class_id: plan.class_id, teaching_group_id: plan.teaching_group_id, name: `${plan.name} (koopia)`, rows: plan.rows, cols: plan.cols,
      seat_type: plan.seat_type, mode: plan.mode, seats: plan.seats, avoid_pairs: plan.avoid_pairs, activity_type: plan.activity_type, group_size: plan.group_size, absent_students: plan.absent_students,
    }).select('id, class_id, teaching_group_id, name, rows, cols, seat_type, mode, seats, avoid_pairs, activity_type, group_size, absent_students, updated_at').single()
    if (result.error || !result.data) { setDashboardError('Plaani kopeerimine ei õnnestunud.'); return }
    setSavedPlans((current) => [result.data as SeatingPlan, ...current])
    setDashboardNotice(`Loodud plaani „${plan.name}“ koopia.`)
  }

  async function deletePlan(plan: SeatingPlan) {
    if (!supabase || !window.confirm(`Kas kustutada isteplaan „${plan.name}“?`)) return
    const result = await supabase.from('seating_plans').delete().eq('id', plan.id)
    if (result.error) { setDashboardError('Plaani kustutamine ei õnnestunud.'); return }
    setSavedPlans((current) => current.filter((item) => item.id !== plan.id))
    setDashboardNotice(`Isteplaan „${plan.name}“ on kustutatud.`)
  }

  function startPresentation() {
    if (!resultGenerated) return
    setPresentationMode(true); setRevealCount(0); setAnimationTick(0); setDrawing(false)
  }

  function beginDraw() {
    setRevealCount(0); setAnimationTick(0); setDrawing(true)
  }

  function generatePlan(keepLocked = false) {
    const presentStudents = plannerStudents.filter((student) => !absentStudentIds.has(student.id))
    if (activityType === 'groups') {
      const shuffledIds = shuffle(presentStudents.map((student) => student.id))
      const sizes = makeGroupSizes(shuffledIds.length, groupSize)
      let candidateGroups: string[][] = []
      let found = false
      for (let attempt = 0; attempt < 2500; attempt += 1) {
        const candidateIds = attempt ? shuffle(shuffledIds) : shuffledIds
        let offset = 0
        candidateGroups = sizes.map((size) => { const group = candidateIds.slice(offset, offset + size); offset += size; return group })
        if (!groupsViolateRules(candidateGroups, separationRules)) { found = true; break }
      }
      if (!found) { setPlannerError('Nende piirangutega ei leidnud sobivat rühmade jaotust. Vähenda piiranguid või muuda rühma suurust.'); return }
      setGroups(candidateGroups)
      setPlannerError(''); return
    }
    if (seatCount < presentStudents.length) { setPlannerError(`Kohti on ${seatCount}, aga kohal on ${presentStudents.length} õpilast. Lisa laudu.`); return }
    const presentSoloIds = new Set([...soloStudentIds].filter((id) => presentStudents.some((student) => student.id === id)))
    const availableCapacities = Array.from({ length: totalDeskCount }, (_, deskIndex) => disabledDesks.has(deskIndex) ? 0 : capacityForDesk(deskIndex)).filter(Boolean).sort((first, second) => first - second)
    const capacityAfterSoloDesks = availableCapacities.slice(presentSoloIds.size).reduce((sum, capacity) => sum + capacity, 0)
    if (presentSoloIds.size > availableCapacities.length || capacityAfterSoloDesks < presentStudents.length - presentSoloIds.size) { setPlannerError(`${presentSoloIds.size} õpilast soovib üksi istuda, kuid selle paigutusega pole piisavalt laudu. Lisa laudu, suurenda mõne laua kohtade arvu või vähenda üksinda istujate arvu.`); return }
    const locked = keepLocked ? lockedStudents : new Set<string>()
    const base = Array<string | null>(totalSeatSlots).fill(null)
    if (keepLocked) assignments.slice(0, totalSeatSlots).forEach((studentId, index) => { if (studentId && locked.has(studentId) && !disabledDesks.has(Math.floor(index / seatsPerDesk))) base[index] = studentId })
    const remaining = presentStudents.map((student) => student.id).filter((id) => !locked.has(id))
    const orderedDeskIndexes = Array.from({ length: totalDeskCount }, (_, index) => index)
      .filter((index) => !disabledDesks.has(index))
      .sort((first, second) => Math.floor(second / deskColumns) - Math.floor(first / deskColumns) || first - second)
    let candidate = base
    let found = false
    for (let attempt = 0; attempt < 2500; attempt += 1) {
      candidate = [...base]
      const blockedSeats = new Set<number>()
      if (seatsPerDesk > 1) {
        orderedDeskIndexes.forEach((deskIndex) => {
          const first = deskIndex * seatsPerDesk
          const deskSeats = Array.from({ length: capacityForDesk(deskIndex) }, (_, position) => first + position)
          const soloSeat = deskSeats.find((seatIndex) => candidate[seatIndex] && presentSoloIds.has(candidate[seatIndex]!))
          if (soloSeat !== undefined) {
            deskSeats.filter((seatIndex) => seatIndex !== soloSeat).forEach((seatIndex) => blockedSeats.add(seatIndex))
          }
        })
      }
      const remainingSolo = shuffle(remaining.filter((id) => presentSoloIds.has(id)))
      const remainingOthers = shuffle(remaining.filter((id) => !presentSoloIds.has(id)))
      for (const studentId of remainingSolo) {
        const deskIndex = orderedDeskIndexes.find((desk) => {
          const first = desk * seatsPerDesk
          return Array.from({ length: capacityForDesk(desk) }, (_, position) => candidate[first + position]).every((value) => value === null)
        })
        if (deskIndex === undefined) break
        const seatIndex = deskIndex * seatsPerDesk
        candidate[seatIndex] = studentId
        Array.from({ length: capacityForDesk(deskIndex) - 1 }, (_, position) => seatIndex + position + 1).forEach((index) => blockedSeats.add(index))
      }
      const freeIndexes = orderedDeskIndexes.flatMap((desk) => Array.from({ length: capacityForDesk(desk) }, (_, position) => desk * seatsPerDesk + position))
        .filter((index) => candidate[index] === null && !blockedSeats.has(index))
      remainingOthers.forEach((studentId, index) => { if (freeIndexes[index] !== undefined) candidate[freeIndexes[index]] = studentId })
      if (candidate.filter(Boolean).length !== presentStudents.length) continue
      const soloConflict = seatsPerDesk > 1 && orderedDeskIndexes.some((deskIndex) => {
        const deskMembers = candidate.slice(deskIndex * seatsPerDesk, deskIndex * seatsPerDesk + capacityForDesk(deskIndex)).filter((id): id is string => Boolean(id))
        return deskMembers.length > 1 && deskMembers.some((id) => presentSoloIds.has(id))
      })
      if (soloConflict) continue
      if (!violatesSeparation(candidate, separationRules, deskColumns, seatsPerDesk)) { found = true; break }
    }
    if (!found) { setPlannerError('Selle lauapaigutuse ja valitud erisustega ei leidnud sobivat paigutust. Lisa kohti või muuda mõnda erisust.'); return }
    setAssignments(candidate); setLockedStudents(locked); setPlannerError('')
  }

  function toggleAbsent(studentId: string) {
    const isCurrentlyAbsent = absentStudentIds.has(studentId)
    setAbsentStudentIds((current) => { const next = new Set(current); next.has(studentId) ? next.delete(studentId) : next.add(studentId); return next })
    setSoloStudentIds((current) => { const next = new Set(current); if (!isCurrentlyAbsent) next.delete(studentId); return next })
    if (activityType === 'groups' && groups.length) {
      setGroups((current) => {
        if (!isCurrentlyAbsent) return current.map((group) => group.filter((id) => id !== studentId)).filter((group) => group.length)
        return addToSmallestAllowedGroup(current, studentId, separationRules)
      })
    } else { setAssignments([]); setGroups([]); setLockedStudents(new Set()) }
  }

  function addSeparationRule() {
    if (!ruleFirst || !ruleSecond || ruleFirst === ruleSecond) { setPlannerError('Vali kaks erinevat õpilast.'); return }
    if (separationRules.some((rule) => [rule.firstId, rule.secondId].includes(ruleFirst) && [rule.firstId, rule.secondId].includes(ruleSecond))) { setPlannerError('See piirang on juba lisatud.'); return }
    setSeparationRules((current) => [...current, { firstId: ruleFirst, secondId: ruleSecond }])
    setRuleFirst(''); setRuleSecond(''); setAssignments([]); setGroups([]); setLockedStudents(new Set()); setPlannerError('')
  }

  function addGroupRestrictionSet() {
    const members = [...groupRuleSelection]
    if (members.length < 2) { setPlannerError('Vali piirangusse vähemalt kaks õpilast.'); return }
    const setId = crypto.randomUUID()
    const rules: SeparationRule[] = []
    members.forEach((firstId, firstIndex) => members.slice(firstIndex + 1).forEach((secondId) => rules.push({ firstId, secondId, setId })))
    setSeparationRules((current) => [...current, ...rules])
    setGroupRuleSelection(new Set()); setGroupRuleSearch(''); setGroups([]); setPlannerError('')
  }

  function moveGroupMember(toGroup: number) {
    if (!draggedGroupMember || draggedGroupMember.fromGroup === toGroup) { setDraggedGroupMember(null); return }
    const next = groups.map((group) => [...group])
    next[draggedGroupMember.fromGroup] = next[draggedGroupMember.fromGroup].filter((id) => id !== draggedGroupMember.studentId)
    next[toGroup].push(draggedGroupMember.studentId)
    if (groupsViolateRules(next, separationRules)) {
      setPlannerError('Seda õpilast ei saa sellesse rühma tõsta, sest üks juhitud piirang keelab selle.'); setDraggedGroupMember(null); return
    }
    setGroups(next.filter((group) => group.length)); setDraggedGroupMember(null); setPlannerError('')
  }

  function moveStudent(fromIndex: number, toIndex: number) {
    setAssignments((current) => {
      const next = [...current]
      ;[next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]]
      return next
    })
    setPlannerError('')
  }

  function toggleStudentLock(studentId: string) {
    setLockedStudents((current) => {
      const next = new Set(current)
      next.has(studentId) ? next.delete(studentId) : next.add(studentId)
      return next
    })
  }

  function toggleDesk(deskIndex: number) {
    setDisabledDesks((current) => {
      const next = new Set(current)
      next.has(deskIndex) ? next.delete(deskIndex) : next.add(deskIndex)
      return next
    })
    setAssignments([])
    setLockedStudents(new Set())
    setPlannerError('')
  }

  function cycleDeskCapacity(deskIndex: number) {
    setDeskCapacities((current) => {
      const next = Array.from({ length: totalDeskCount }, (_, index) => current[index] || 2)
      next[deskIndex] = next[deskIndex] === 3 ? 1 : next[deskIndex] + 1
      return next
    })
    setAssignments([]); setLockedStudents(new Set()); setPlannerError('')
  }

  function openTeachingGroupEditor(group?: TeachingGroup) {
    const memberIds = new Set(group ? teachingGroupMembers.filter((member) => member.group_id === group.id).map((member) => member.student_id) : [])
    setSelectedTeachingGroup(null); setEditingTeachingGroup(group || null); setTeachingGroupName(group?.name || ''); setTeachingGroupStudentIds(memberIds)
    setTeachingGroupClassIds(new Set(students.filter((student) => memberIds.has(student.id)).map((student) => student.class_id)))
    setTeachingGroupSearch(''); setDashboardError(''); setShowTeachingGroupForm(true)
  }

  function toggleTeachingGroupClass(classId: string) {
    setTeachingGroupClassIds((current) => {
      const next = new Set(current)
      if (next.has(classId)) {
        next.delete(classId)
        const removedStudentIds = new Set(students.filter((student) => student.class_id === classId).map((student) => student.id))
        setTeachingGroupStudentIds((selected) => new Set([...selected].filter((id) => !removedStudentIds.has(id))))
      } else next.add(classId)
      return next
    })
  }

  async function saveTeachingGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !session || !teachingGroupName.trim()) return
    if (!teachingGroupStudentIds.size) { setDashboardError('Vali õpperühma vähemalt üks õpilane.'); return }
    setSavingTeachingGroup(true); setDashboardError('')
    let group = editingTeachingGroup
    if (group) {
      const updated = await supabase.from('teaching_groups').update({ name: teachingGroupName.trim(), updated_at: new Date().toISOString() }).eq('id', group.id).select('id, teacher_id, name, updated_at').single()
      if (updated.error || !updated.data) { setSavingTeachingGroup(false); setDashboardError('Õpperühma muutmine ei õnnestunud.'); return }
      group = updated.data as TeachingGroup
      const removed = await supabase.from('teaching_group_students').delete().eq('group_id', group.id)
      if (removed.error) { setSavingTeachingGroup(false); setDashboardError('Õpperühma liikmete uuendamine ei õnnestunud.'); return }
    } else {
      const created = await supabase.from('teaching_groups').insert({ teacher_id: session.user.id, name: teachingGroupName.trim() }).select('id, teacher_id, name, updated_at').single()
      if (created.error || !created.data) { setSavingTeachingGroup(false); setDashboardError('Õpperühma loomine ei õnnestunud.'); return }
      group = created.data as TeachingGroup
    }
    const members = [...teachingGroupStudentIds].map((studentId) => ({ group_id: group!.id, student_id: studentId }))
    const memberResult = await supabase.from('teaching_group_students').insert(members).select('group_id, student_id')
    setSavingTeachingGroup(false)
    if (memberResult.error) { setDashboardError('Õpperühma liikmete salvestamine ei õnnestunud.'); return }
    setTeachingGroups((current) => [...current.filter((item) => item.id !== group!.id), group!].sort((a, b) => classNameCollator.compare(a.name, b.name)))
    setTeachingGroupMembers((current) => [...current.filter((member) => member.group_id !== group!.id), ...((memberResult.data || []) as TeachingGroupMember[])])
    setShowTeachingGroupForm(false); setEditingTeachingGroup(null); setDashboardNotice(`Õpperühm „${group.name}“ on salvestatud.`)
  }

  async function deleteTeachingGroup(group: TeachingGroup) {
    if (!supabase || !window.confirm(`Kas kustutada õpperühm „${group.name}“ ja selle salvestatud plaanid?`)) return
    const result = await supabase.from('teaching_groups').delete().eq('id', group.id)
    if (result.error) { setDashboardError('Õpperühma kustutamine ei õnnestunud.'); return }
    setTeachingGroups((current) => current.filter((item) => item.id !== group.id)); setTeachingGroupMembers((current) => current.filter((member) => member.group_id !== group.id)); setSavedPlans((current) => current.filter((plan) => plan.teaching_group_id !== group.id)); setSelectedTeachingGroup(null)
    setDashboardNotice(`Õpperühm „${group.name}“ on kustutatud.`)
  }

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
    const classResult = await supabase.from('school_classes').insert({ name: className.trim(), academic_year: academicYear.trim() }).select('id, name, academic_year, archived').single()
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

      const classesResult = await supabase.from('school_classes').insert(classRecords).select('id, name, academic_year, archived')
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

  async function openUsersView() {
    if (!supabase || profile?.role !== 'admin') return
    setShowUsers(true); setUsersLoading(true); setUsersError('')
    const result = await supabase.rpc('admin_user_overview')
    setUsersLoading(false)
    if (result.error) { setUsersError('Kasutajate vaadet ei õnnestunud laadida. Käivita esmalt Supabase’i SQL-muudatus.'); return }
    setAdminUsers((result.data || []) as AdminUser[])
  }

  async function saveProfileName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setSavingProfile(true); setProfileError('')
    const result = await supabase.rpc('update_my_display_name', { new_name: profileName })
    setSavingProfile(false)
    if (result.error) { setProfileError('Nime salvestamine ei õnnestunud. Käivita esmalt Supabase’i viimistluse SQL.'); return }
    setProfile((current) => current ? { ...current, display_name: String(result.data) } : current)
    setShowProfile(false)
  }

  async function setClassArchived(schoolClass: SchoolClass, archived: boolean) {
    if (!supabase || profile?.role !== 'admin') return
    if (archived && !window.confirm(`Kas arhiveerida klass „${schoolClass.name}“? Õpilased ja plaanid säilivad.`)) return
    const result = await supabase.from('school_classes').update({ archived }).eq('id', schoolClass.id)
    if (result.error) { setDashboardError('Klassi arhiivioleku muutmine ei õnnestunud.'); return }
    setClasses((current) => current.map((item) => item.id === schoolClass.id ? { ...item, archived } : item))
    setSelectedClass(null); setDashboardNotice(archived ? `Klass ${schoolClass.name} on arhiveeritud.` : `Klass ${schoolClass.name} on taastatud.`)
  }

  async function permanentlyDeleteClass(schoolClass: SchoolClass) {
    if (!supabase || profile?.role !== 'admin') return
    const confirmation = window.prompt(`Klassi, õpilaste ja kõigi seotud plaanide lõplikuks kustutamiseks kirjuta: ${schoolClass.name}`)
    if (confirmation !== schoolClass.name) return
    const result = await supabase.from('school_classes').delete().eq('id', schoolClass.id)
    if (result.error) { setDashboardError('Klassi kustutamine ei õnnestunud.'); return }
    setClasses((current) => current.filter((item) => item.id !== schoolClass.id)); setStudents((current) => current.filter((student) => student.class_id !== schoolClass.id)); setSavedPlans((current) => current.filter((plan) => plan.class_id !== schoolClass.id))
    setDashboardNotice(`Klass ${schoolClass.name} on lõplikult kustutatud.`)
  }

  async function saveCurrentAsNewPlan() {
    if (!supabase || !session || !plannerClass || !resultGenerated) return
    setSavingPlan(true); setPlannerError('')
    const result = await supabase.from('seating_plans').insert({
      teacher_id: session.user.id, class_id: plannerTeachingGroup ? null : plannerClass.id, teaching_group_id: plannerTeachingGroup?.id || null, name: `${planName.trim() || plannerClass.name} (koopia)`, rows: deskRows, cols: deskColumns,
      seat_type: deskType, mode: drawMode, activity_type: activityType, group_size: activityType === 'groups' ? groupSize : null,
      seats: activityType === 'groups' ? groups.flatMap((group, groupIndex) => group.map((studentId) => ({ student_id: studentId, group: groupIndex }))) : assignments.map((studentId, index) => ({ student_id: studentId, disabled: disabledDesks.has(Math.floor(index / seatsPerDesk)), solo: Boolean(studentId && soloStudentIds.has(studentId)), desk_size: capacityForDesk(Math.floor(index / seatsPerDesk)) })), avoid_pairs: separationRules, absent_students: [...absentStudentIds],
    }).select('id, class_id, teaching_group_id, name, rows, cols, seat_type, mode, seats, avoid_pairs, activity_type, group_size, absent_students, updated_at').single()
    setSavingPlan(false)
    if (result.error || !result.data) { setPlannerError('Uue plaani salvestamine ei õnnestunud.'); return }
    const saved = result.data as SeatingPlan
    setEditingPlanId(saved.id); setPlanName(saved.name); setSavedPlans((current) => [saved, ...current]); setDashboardNotice(`Uus isteplaan „${saved.name}“ on salvestatud.`)
  }

  if (loading) return <main className="center-page"><div className="loader" aria-label="Laen" /></main>

  if (session) {
    const displayName = profile?.display_name || session.user.email?.split('@')[0] || 'õpetaja'
    return <div className="app-shell">
      <header className="topbar">
        <a className="brand brand--small" href={import.meta.env.BASE_URL} aria-label="Avaleht"><img className="school-logo" src={logoUrl} alt="Loo Kool" /><span className="brand-divider" /><span>Isteplaan</span></a>
        <div className="account"><button className="account-name" onClick={() => { setProfileName(profile?.display_name || displayName); setProfileError(''); setShowProfile(true) }}>{displayName}</button>{profile?.role === 'admin' && <span className="badge">Admin</span>}<button className="button button--ghost button--compact" onClick={() => setShowHelp(true)}>Juhend</button><button className="button button--ghost button--compact" onClick={signOut}>Logi välja</button></div>
      </header>
      <main className="dashboard">
        <section className="welcome-card">
          <div><span className="eyebrow">Klasside töölaud</span><h1>Vali klass ja loo uus isteplaan.</h1><p>Märgi sagedamini kasutatavad klassid tärniga. Õpilaste nimekirjad on nähtavad ainult sisselogitud koolitöötajatele.</p></div>
          {profile?.role === 'admin' && <div className="admin-shortcuts"><button className="button button--ghost" onClick={openUsersView}>Kasutajad</button><button className="button button--gold" onClick={() => setShowAdminForm(true)}>+ Lisa klass</button></div>}
        </section>
        {(dashboardError || dashboardNotice) && <div className={`notice dashboard-notice ${dashboardError ? 'notice--error' : 'notice--success'}`} role="status">{dashboardError || dashboardNotice}</div>}
        <div className="dashboard-view-tabs"><button className={dashboardView === 'classes' ? 'active' : ''} onClick={() => setDashboardView('classes')}>▦ Klassid</button><button className={dashboardView === 'teaching-groups' ? 'active' : ''} onClick={() => setDashboardView('teaching-groups')}>👥 Õpperühmad <span>{teachingGroups.length}</span></button></div>
        {dashboardView === 'classes' && <section className="class-section">
          <div className="section-heading">
            <div><span className="eyebrow">Klassid</span><h2>{viewFilter === 'favorites' ? 'Minu klassid' : 'Kõik klassid'}</h2></div>
            <div className="class-tools">
              <div className="segmented" aria-label="Klasside filter">
                <button className={viewFilter === 'favorites' ? 'active' : ''} onClick={() => setViewFilter('favorites')}>★ Minu klassid <span>{favoriteIds.size}</span></button>
                <button className={viewFilter === 'all' ? 'active' : ''} onClick={() => setViewFilter('all')}>Kõik <span>{activeClasses.length}</span></button>
              </div>
              {profile?.role === 'admin' && <button className="archive-button" onClick={() => setShowArchive(true)}>Arhiiv ({archivedClasses.length})</button>}
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
        </section>}
        {dashboardView === 'teaching-groups' && <section className="class-section teaching-groups-section"><div className="section-heading"><div><span className="eyebrow">Minu õpperühmad</span><h2>Õpperühmad</h2><p>Koonda ühe või mitme klassi õpilased püsivasse tunni- või keelerühma.</p></div><button className="button button--gold" onClick={() => openTeachingGroupEditor()}>+ Loo õpperühm</button></div>{dataLoading ? <div className="data-state"><div className="loader" /><p>Laen õpperühmi…</p></div> : teachingGroups.length ? <div className="class-grid">{teachingGroups.map((group) => { const memberCount = teachingGroupMembers.filter((member) => member.group_id === group.id).length; return <article className="class-card teaching-group-card" key={group.id}><button className="class-card__main" onClick={() => setSelectedTeachingGroup(group)}><span className="class-icon">ÕR</span><span className="class-card__copy"><strong>{group.name}</strong><span>{memberCount} õpilast</span></span><span className="arrow">→</span></button></article> })}</div> : <div className="empty-state"><span>👥</span><h3>Õpperühmi pole veel loodud</h3><p>Loo näiteks keelerühm ning vali sinna õpilased ühest või mitmest klassist.</p><button className="button" onClick={() => openTeachingGroupEditor()}>+ Loo esimene õpperühm</button></div>}</section>}
      </main>

      {showProfile && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowProfile(false)}><section className="modal small-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title"><div className="modal-header"><div><span className="eyebrow">Minu konto</span><h2 id="profile-title">Kuvatav nimi</h2><p>Seda nime näed rakenduse ülaservas.</p></div><button className="icon-button" onClick={() => setShowProfile(false)}>×</button></div><form onSubmit={saveProfileName}><div className="field"><label htmlFor="profile-name">Nimi</label><input id="profile-name" value={profileName} onChange={(event) => setProfileName(event.target.value)} minLength={2} maxLength={100} required /></div>{profileError && <div className="notice notice--error">{profileError}</div>}<div className="modal-actions"><button type="button" className="button button--ghost" onClick={() => setShowProfile(false)}>Loobu</button><button className="button" disabled={savingProfile}>{savingProfile ? 'Salvestan…' : 'Salvesta nimi'}</button></div></form></section></div>}

      {showHelp && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowHelp(false)}><section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-header"><div><span className="eyebrow">Lühijuhend</span><h2 id="help-title">Kuidas rakendust kasutada?</h2></div><button className="icon-button" onClick={() => setShowHelp(false)}>×</button></div><div className="help-tabs" role="tablist"><button className={helpSection === 'seating' ? 'active' : ''} onClick={() => setHelpSection('seating')}>🪑 Istekohtade loosimine</button><button className={helpSection === 'groups' ? 'active' : ''} onClick={() => setHelpSection('groups')}>👥 Rühmade loosimine</button></div>{helpSection === 'seating' ? <ol className="help-steps"><li><b>Vali klass ja „Istumiskohad“.</b><span>Ava vajalik klass ning vali töövormiks istekohtade loosimine.</span></li><li><b>Märgi puudujad ja üksinda istujad.</b><span>Puudujad jäetakse loosist välja. Mitmekohaliste laudade puhul saad märkida ka õpilased, kes soovivad üksi istuda.</span></li><li><b>Seadista klassiruum.</b><span>Vali üksikud, paaris- või hübriidlauad ning määra read ja veerud. Hübriidpaigutuses saad iga laua eraldi ühe-, kahe- või kolmekohaliseks muuta; üleliigsed lauad saab eemaldada.</span></li><li><b>Vali loosimise viis.</b><span>Juhuslik loos paigutab kõik õpilased. Juhitud loosis saad nimed paika lohistada, vajalikud kohad lukustada ja ülejäänud uuesti loosida.</span></li><li><b>Lisa vajaduse korral erisused.</b><span>Määra õpilased, kes ei tohi istuda koos ega lähestikku – samas lauas, kõrval, ees või taga.</span></li><li><b>Salvesta, esitle või ekspordi.</b><span>Pane plaanile nimi ja salvesta. Klassivaates saad loosimist näidata ning valmis plaani PDF-ina eksportida.</span></li></ol> : <ol className="help-steps"><li><b>Vali klass ja „Rühmatöö“.</b><span>Rühmade loosimine ei sõltu klassiruumi laudade arvust ega paigutusest.</span></li><li><b>Märgi puudujad.</b><span>Kasuta nime leidmiseks otsingut. Puudujad jäetakse rühmade loosist välja.</span></li><li><b>Määra rühma suurus ja loosimise viis.</b><span>Juhuslik loos loob valmis rühmad. Juhitud loosis saad pärast õpilaste nimesid rühmade vahel lohistada.</span></li><li><b>Lisa vajaduse korral erisused.</b><span>Vali üheks nimistuks õpilased, kes ei tohi omavahel samasse rühma sattuda. Võid lisada mitu eraldi nimistut.</span></li><li><b>Loosi ja kohanda rühmi.</b><span>Vajuta „Loosi rühmad“. Juhitud režiimis lohista vajaduse korral nimesid ümber; piirangut rikkuvat tõstmist ei lubata.</span></li><li><b>Salvesta rühmad.</b><span>Pane jaotusele nimi ja salvesta see, et sama rühmade jaotust hiljem uuesti kasutada.</span></li><li><b>Kontrolli järgmisel korral puudujaid.</b><span>Tagasitulev õpilane lisatakse kõige väiksemasse sobivasse rühma. Ülejäänud rühmi ümber ei loosita.</span></li></ol>}<div className="modal-actions"><button className="button" onClick={() => setShowHelp(false)}>Selge</button></div></section></div>}

      {showArchive && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowArchive(false)}><section className="modal archive-modal" role="dialog" aria-modal="true" aria-labelledby="archive-title"><div className="modal-header"><div><span className="eyebrow">Administraator</span><h2 id="archive-title">Klasside arhiiv</h2><p>Arhiveerimine peidab klassi töölaudade vaates, kuid säilitab nimekirja ja plaanid.</p></div><button className="icon-button" onClick={() => setShowArchive(false)}>×</button></div>{archivedClasses.length ? <div className="archive-list">{archivedClasses.map((schoolClass) => <div key={schoolClass.id}><span><strong>{schoolClass.name}</strong><small>{schoolClass.academic_year} · {studentCountByClass[schoolClass.id] || 0} õpilast</small></span><button onClick={() => setClassArchived(schoolClass, false)}>Taasta</button><button className="danger-action" onClick={() => permanentlyDeleteClass(schoolClass)}>Kustuta lõplikult</button></div>)}</div> : <div className="mini-empty">Arhiiv on tühi.</div>}</section></div>}

      {showUsers && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowUsers(false)}><section className="modal users-modal" role="dialog" aria-modal="true" aria-labelledby="users-title">
        <div className="modal-header"><div><span className="eyebrow">Administraator</span><h2 id="users-title">Kasutajad</h2><p>Õpetajate kontod ja rakenduse kasutuse koondvaade.</p></div><button className="icon-button" onClick={() => setShowUsers(false)} aria-label="Sulge">×</button></div>
        {!usersLoading && !usersError && <div className="user-stats"><div><strong>{adminUsers.length}</strong><span>kasutajat</span></div><div><strong>{adminUsers.filter((user) => user.last_seen_at).length}</strong><span>rakendust kasutanud</span></div><div><strong>{adminUsers.reduce((sum, user) => sum + Number(user.plan_count), 0)}</strong><span>salvestatud plaani</span></div></div>}
        <input className="user-search" type="search" placeholder="Otsi nime või e-posti järgi…" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} />
        {usersLoading ? <div className="data-state"><div className="loader" /><p>Laen kasutajaid…</p></div> : usersError ? <div className="notice notice--error">{usersError}</div> : <div className="users-table">
          {filteredAdminUsers.map((user) => <article key={user.user_id} className={!user.active ? 'user-card user-card--inactive' : 'user-card'}>
            <div className="user-identity"><span>{(user.display_name || user.email).slice(0, 1).toUpperCase()}</span><div><strong>{user.display_name || user.email.split('@')[0]}</strong><small>{user.email}</small></div>{user.role === 'admin' && <b>Admin</b>}</div>
            <div className="user-activity"><span><small>Liitus</small>{new Date(user.joined_at).toLocaleDateString('et-EE')}</span><span><small>Viimati kasutas</small>{user.last_seen_at ? new Date(user.last_seen_at).toLocaleString('et-EE', { dateStyle: 'short', timeStyle: 'short' }) : 'Pole veel kasutanud'}</span><span><small>Plaane</small>{user.plan_count}</span></div>
            <div className="user-classes"><div><small>Tärniga klassid</small>{user.favorite_classes.length ? user.favorite_classes.map((name) => <span key={name}>★ {name}</span>) : <em>Puuduvad</em>}</div><div><small>Plaanid klassidele</small>{user.saved_classes.length ? user.saved_classes.map((name) => <span key={name}>{name}</span>) : <em>Puuduvad</em>}</div></div>
          </article>)}
          {!filteredAdminUsers.length && <div className="mini-empty">Sobivaid kasutajaid ei leitud.</div>}
        </div>}
      </section></div>}

      {selectedClass && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedClass(null)}><section className="modal roster-modal" role="dialog" aria-modal="true" aria-labelledby="roster-title">
        <div className="modal-header"><div><span className="eyebrow">{selectedClass.academic_year}</span><h2 id="roster-title">{selectedClass.name}</h2><p>{selectedStudents.length} õpilast</p></div><button className="icon-button" onClick={() => setSelectedClass(null)} aria-label="Sulge">×</button></div>
        {selectedStudents.length ? <ol className="student-list">{selectedStudents.map((student) => <li key={student.id}><span>{student.first_name} {student.last_name}</span></li>)}</ol> : <div className="mini-empty">Selles klassis pole veel õpilasi.</div>}
        {savedPlans.some((plan) => plan.class_id === selectedClass.id) && <div className="saved-plan-list"><strong>Minu salvestatud plaanid</strong>{savedPlans.filter((plan) => plan.class_id === selectedClass.id).map((plan) => <div key={plan.id}><span><b>{plan.name}</b><small>Muudetud {new Date(plan.updated_at).toLocaleDateString('et-EE')}</small></span><button onClick={() => openSavedPlan(plan)}>Muuda</button><button onClick={() => openSavedPlan(plan, true)}>Klassivaade</button><button onClick={() => copyPlan(plan)}>Kopeeri</button><button className="danger-action" onClick={() => deletePlan(plan)}>Kustuta</button></div>)}</div>}
        <div className="modal-actions">{profile?.role === 'admin' && <><button className="button button--ghost button--edit" onClick={() => openClassEditor(selectedClass)}>Muuda klassi</button><button className="button button--danger-ghost" onClick={() => setClassArchived(selectedClass, true)}>Arhiveeri</button></>}<button className="button button--ghost" onClick={() => setSelectedClass(null)}>Sulge</button><button className="button" onClick={() => openPlanner(selectedClass)}>Koosta isteplaan →</button></div>
      </section></div>}

      {selectedTeachingGroup && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedTeachingGroup(null)}><section className="modal roster-modal" role="dialog" aria-modal="true" aria-labelledby="teaching-group-title"><div className="modal-header"><div><span className="eyebrow">Õpperühm</span><h2 id="teaching-group-title">{selectedTeachingGroup.name}</h2><p>{selectedTeachingGroupStudents.length} õpilast · {new Set(selectedTeachingGroupStudents.map((student) => student.class_id)).size} klassist</p></div><button className="icon-button" onClick={() => setSelectedTeachingGroup(null)} aria-label="Sulge">×</button></div><ol className="student-list">{selectedTeachingGroupStudents.map((student) => <li key={student.id}><span>{student.first_name} {student.last_name}</span><small>{classes.find((schoolClass) => schoolClass.id === student.class_id)?.name}</small></li>)}</ol>{savedPlans.some((plan) => plan.teaching_group_id === selectedTeachingGroup.id) && <div className="saved-plan-list"><strong>Minu salvestatud plaanid</strong>{savedPlans.filter((plan) => plan.teaching_group_id === selectedTeachingGroup.id).map((plan) => <div key={plan.id}><span><b>{plan.name}</b><small>Muudetud {new Date(plan.updated_at).toLocaleDateString('et-EE')}</small></span><button onClick={() => openSavedPlan(plan)}>Muuda</button><button onClick={() => openSavedPlan(plan, true)}>Klassivaade</button><button onClick={() => copyPlan(plan)}>Kopeeri</button><button className="danger-action" onClick={() => deletePlan(plan)}>Kustuta</button></div>)}</div>}<div className="modal-actions"><button className="button button--danger-ghost" onClick={() => deleteTeachingGroup(selectedTeachingGroup)}>Kustuta</button><button className="button button--ghost" onClick={() => openTeachingGroupEditor(selectedTeachingGroup)}>Muuda rühma</button><button className="button" onClick={() => openTeachingGroupPlanner(selectedTeachingGroup)}>Koosta isteplaan →</button></div></section></div>}

      {showTeachingGroupForm && <div className="modal-backdrop" role="presentation"><section className="modal teaching-group-modal" role="dialog" aria-modal="true" aria-labelledby="teaching-group-form-title"><div className="modal-header"><div><span className="eyebrow">Õpperühm</span><h2 id="teaching-group-form-title">{editingTeachingGroup ? 'Muuda õpperühma' : 'Loo õpperühm'}</h2><p>Vali klassid ja seejärel konkreetsed õpilased.</p></div><button className="icon-button" onClick={() => setShowTeachingGroupForm(false)} aria-label="Sulge">×</button></div><form onSubmit={saveTeachingGroup}><div className="field"><label htmlFor="teaching-group-name">Õpperühma nimi</label><input id="teaching-group-name" value={teachingGroupName} onChange={(event) => setTeachingGroupName(event.target.value)} placeholder="Näiteks 8.a ja 8.b inglise keel – I rühm" required /></div><div className="teaching-group-builder"><div><strong>1. Vali klassid</strong><div className="class-checkboxes">{activeClasses.map((schoolClass) => <label key={schoolClass.id}><input type="checkbox" checked={teachingGroupClassIds.has(schoolClass.id)} onChange={() => toggleTeachingGroupClass(schoolClass.id)} /><span>{schoolClass.name}</span></label>)}</div></div><div><strong>2. Vali õpilased <span>({teachingGroupStudentIds.size})</span></strong><input className="picker-search" type="search" placeholder="Otsi õpilast…" value={teachingGroupSearch} onChange={(event) => setTeachingGroupSearch(event.target.value)} /><div className="teaching-student-picker">{teachingGroupCandidateStudents.map((student) => <label key={student.id}><input type="checkbox" checked={teachingGroupStudentIds.has(student.id)} onChange={() => setTeachingGroupStudentIds((current) => { const next = new Set(current); next.has(student.id) ? next.delete(student.id) : next.add(student.id); return next })} /><span>{student.first_name} {student.last_name}</span><small>{classes.find((schoolClass) => schoolClass.id === student.class_id)?.name}</small></label>)}{!teachingGroupClassIds.size && <p>Vali esmalt vähemalt üks klass.</p>}</div></div></div><div className="modal-actions"><button type="button" className="button button--ghost" onClick={() => setShowTeachingGroupForm(false)}>Loobu</button><button className="button" disabled={savingTeachingGroup}>{savingTeachingGroup ? 'Salvestan…' : 'Salvesta õpperühm'}</button></div></form></section></div>}

      {showAbsences && pendingPlan && <div className="modal-backdrop"><section className="modal absence-modal" role="dialog" aria-modal="true" aria-labelledby="absence-title"><div className="modal-header"><div><span className="eyebrow">Kohaloleku kontroll</span><h2 id="absence-title">Eelmisel korral puudusid</h2><p>Kontrolli nimed üle enne plaani avamist.</p></div></div><div className="previous-absences">{pendingPlan.absent_students.map((studentId) => { const student = students.find((item) => item.id === studentId); return <label key={studentId}><input type="checkbox" checked={absentStudentIds.has(studentId)} onChange={() => setAbsentStudentIds((current) => { const next = new Set(current); next.has(studentId) ? next.delete(studentId) : next.add(studentId); return next })} /><span>{student?.first_name} {student?.last_name}</span><small>{absentStudentIds.has(studentId) ? 'On ikka puudu' : 'On kohal'}</small></label> })}</div><p className="absence-help">Kui õpilane on nüüd kohal, lisatakse ta isteplaanil vabale tahvlipoolsele kohale. Rühmatöös lisatakse ta kõige väiksemasse rühma – teisi ümber ei loosita.</p><div className="modal-actions"><button className="button button--ghost" onClick={() => { setAbsentStudentIds(new Set()); applySavedPlan(pendingPlan, false, new Set()); setShowAbsences(false); setPendingPlan(null) }}>Kõik on kohal</button><button className="button" onClick={() => { applySavedPlan(pendingPlan, false, absentStudentIds); setShowAbsences(false); setPendingPlan(null) }}>Jätka märgitutega</button></div></section></div>}

      {plannerClass && <div className="planner-page">
        <header className="planner-topbar"><div><button className="back-button" onClick={() => setPlannerClass(null)}>← Tagasi</button><span>{plannerClass.name} · {plannerStudents.length} õpilast</span></div><strong>Isteplaani koostaja</strong></header>
        <main className="planner-layout">
          <aside className="planner-controls">
            <div><span className="eyebrow">Töövorm</span><h2>Mida loosime?</h2></div>
            <div className="option-grid"><button className={activityType === 'seating' ? 'active' : ''} onClick={() => { setActivityType('seating'); setGroups([]) }}><strong>🪑 Istumiskohad</strong><span>Paiguta õpilased klassiruumi</span></button><button className={activityType === 'groups' ? 'active' : ''} onClick={() => { setActivityType('groups'); setAssignments([]); setLockedStudents(new Set()) }}><strong>👥 Rühmatöö</strong><span>Loosi tasakaalustatud rühmad</span></button></div>
            {activityType === 'groups' && <><div className="group-size-field"><label>Soovitud liikmeid rühmas<input type="number" min="2" max="12" value={groupSize} onChange={(event) => { setGroupSize(Math.max(2, Number(event.target.value))); setGroups([]) }} /></label><p>Süsteem väldib üheliikmelist rühma ja näitab tegeliku jaotuse.</p></div><div className="option-grid group-mode-picker"><button className={drawMode === 'random' ? 'active' : ''} onClick={() => setDrawMode('random')}><strong>🎲 Juhuslik</strong><span>Loosi valmis rühmad</span></button><button className={drawMode === 'guided' ? 'active' : ''} onClick={() => setDrawMode('guided')}><strong>🎯 Juhitud</strong><span>Lohista pärast nimesid</span></button></div></>}
            <details className="absence-picker"><summary>Puudujad <span>{absentStudentIds.size}</span></summary><div><input className="picker-search" type="search" placeholder="Otsi õpilast…" value={absenceSearch} onChange={(event) => setAbsenceSearch(event.target.value)} />{filteredAbsenceStudents.map((student) => <label key={student.id}><input type="checkbox" checked={absentStudentIds.has(student.id)} onChange={() => toggleAbsent(student.id)} /><span>{student.first_name} {student.last_name}</span></label>)}{!filteredAbsenceStudents.length && <small className="picker-empty">Õpilast ei leitud.</small>}</div></details>
            {activityType === 'seating' && <><div className="control-divider" />
            <div><span className="eyebrow">1. Klassiruum</span><h2>Lauad ja kohad</h2></div>
            <div className="option-grid option-grid--three"><button className={deskType === 'pair' ? 'active' : ''} onClick={() => { setDeskType('pair'); setDeskCapacities(Array(totalDeskCount).fill(2)); setAssignments([]) }}><strong>▭ Paarislauad</strong><span>Kaks kohta</span></button><button className={deskType === 'single' ? 'active' : ''} onClick={() => { setDeskType('single'); setDeskCapacities(Array(totalDeskCount).fill(1)); setAssignments([]) }}><strong>□ Üksikud</strong><span>Üks koht</span></button><button className={deskType === 'mixed' ? 'active' : ''} onClick={() => { setDeskType('mixed'); setDeskCapacities(Array(totalDeskCount).fill(2)); setAssignments([]) }}><strong>▦ Hübriid</strong><span>1–3 kohta</span></button></div>
            <div className="number-fields"><label>Ridu<input type="number" min="1" max="10" value={deskRows} onChange={(event) => { const rows = Math.max(1, Number(event.target.value)); setDeskRows(rows); setDeskCapacities(Array(rows * deskColumns).fill(deskType === 'single' ? 1 : 2)); setDisabledDesks(new Set()); setAssignments([]) }} /></label><label>Veerge<input type="number" min="1" max="10" value={deskColumns} onChange={(event) => { const columns = Math.max(1, Number(event.target.value)); setDeskColumns(columns); setDeskCapacities(Array(deskRows * columns).fill(deskType === 'single' ? 1 : 2)); setDisabledDesks(new Set()); setAssignments([]) }} /></label><div><span>Kohti</span><strong className={seatCount < plannerStudents.length ? 'capacity-bad' : ''}>{seatCount}</strong></div></div>
            <p className="control-help">Üleliigse laua eemaldamiseks vajuta laua nurgas ×. Hübriidpaigutuses vajuta laual nuppu „1/2/3 kohta“, et muuta iga laua suurust eraldi.</p>

            <div className="control-divider" />
            <div><span className="eyebrow">2. Loosimine</span><h2>Vali meetod</h2></div>
            <div className="option-grid"><button className={drawMode === 'random' ? 'active' : ''} onClick={() => setDrawMode('random')}><strong>🎲 Juhuslik</strong><span>Kõik kohad loositakse</span></button><button className={drawMode === 'guided' ? 'active' : ''} onClick={() => setDrawMode('guided')}><strong>🎯 Juhitud</strong><span>Lukusta valitud kohad</span></button></div>

            {deskType !== 'single' && <details className="absence-picker solo-picker"><summary>Soovib üksi istuda <span>{soloStudentIds.size}</span></summary><div><input className="picker-search" type="search" placeholder="Otsi õpilast…" value={soloSearch} onChange={(event) => setSoloSearch(event.target.value)} />{filteredSoloStudents.map((student) => <label key={student.id}><input type="checkbox" checked={soloStudentIds.has(student.id)} onChange={() => { setSoloStudentIds((current) => { const next = new Set(current); next.has(student.id) ? next.delete(student.id) : next.add(student.id); return next }); setAssignments([]); setLockedStudents(new Set()); setPlannerError('') }} /><span>{student.first_name} {student.last_name}</span></label>)}</div></details>}

            <div className="control-divider" />
            <div><span className="eyebrow">3. Piirangud</span><h2>Ei tohi lähestikku</h2><p className="control-help">Neid õpilasi ei paigutata samasse lauda ega kõrvuti, ette või taha.</p></div>
            <div className="rule-picker"><select value={ruleFirst} onChange={(event) => setRuleFirst(event.target.value)}><option value="">Vali esimene…</option>{plannerStudents.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name}</option>)}</select><select value={ruleSecond} onChange={(event) => setRuleSecond(event.target.value)}><option value="">Vali teine…</option>{plannerStudents.filter((student) => student.id !== ruleFirst).map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name}</option>)}</select><button type="button" onClick={addSeparationRule}>+ Lisa</button></div>
            {separationRules.length > 0 && <div className="rule-list">{separationRules.map((rule, index) => <div key={`${rule.firstId}-${rule.secondId}`}><span>{studentById.get(rule.firstId)?.first_name} ↔ {studentById.get(rule.secondId)?.first_name}</span><button onClick={() => setSeparationRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}>×</button></div>)}</div>}
            </>}
            {activityType === 'groups' && <><div className="control-divider" /><div><span className="eyebrow">Erisused</span><h2>Ei tohi samas rühmas olla</h2><p className="control-help">Vali ühe piiranguna terve nimistu. Kõik valitud õpilased paigutatakse üksteisest eraldi rühmadesse.</p></div><details className="absence-picker group-rule-picker" open><summary>Valitud õpilased <span>{groupRuleSelection.size}</span></summary><div><input className="picker-search" type="search" placeholder="Otsi õpilast…" value={groupRuleSearch} onChange={(event) => setGroupRuleSearch(event.target.value)} />{filteredGroupRuleStudents.map((student) => <label key={student.id}><input type="checkbox" checked={groupRuleSelection.has(student.id)} onChange={() => setGroupRuleSelection((current) => { const next = new Set(current); next.has(student.id) ? next.delete(student.id) : next.add(student.id); return next })} /><span>{student.first_name} {student.last_name}</span></label>)}</div></details><button className="button button--ghost button--wide group-rule-add" type="button" onClick={addGroupRestrictionSet}>+ Lisa nimistu piiranguna</button>{groupRestrictionSets.length > 0 && <div className="group-rule-list">{groupRestrictionSets.map((set, index) => <article key={set.id}><div><strong>Piirang {index + 1}</strong><span>{set.members.map((id) => { const student = studentById.get(id); return student ? `${student.first_name} ${student.last_name}` : '' }).filter(Boolean).join(', ')}</span></div><button aria-label="Eemalda piirang" onClick={() => { setSeparationRules((current) => current.filter((rule) => rule.setId ? rule.setId !== set.id : !set.members.includes(rule.firstId) || !set.members.includes(rule.secondId))); setGroups([]); setPlannerError('') }}>×</button></article>)}</div>}</>}
            {plannerError && <div className="notice notice--error" role="alert">{plannerError}</div>}
            <button className="button button--wide draw-button" onClick={() => generatePlan(activityType === 'seating' && drawMode === 'guided' && planGenerated)}>{resultGenerated ? activityType === 'groups' ? '🎲 Loosi rühmad uuesti' : drawMode === 'guided' ? '🎲 Loosi lukustamata kohad' : '🎲 Loosi uuesti' : activityType === 'groups' ? '🎲 Loosi rühmad' : '🎲 Loo isteplaan'}</button>
          </aside>

          <section className="planner-preview">
            <div className="preview-heading"><div><span className="eyebrow">Eelvaade</span><h1>{plannerClass.name}</h1></div>{drawMode === 'guided' && planGenerated && <p>↕ Lohista nimed ümber ja lukusta need, kelle koht peab säilima. Tahvlipoolsed kohad täidetakse esimesena.</p>}</div>
            {activityType === 'groups' ? <div className="groups-canvas">
              {groups.length ? <><div className="group-summary">{Object.entries(groups.reduce<Record<number, number>>((summary, group) => { summary[group.length] = (summary[group.length] || 0) + 1; return summary }, {})).map(([size, count]) => <span key={size}>{count} × {size}-liikmeline</span>)}</div>{drawMode === 'guided' && <p className="group-drag-hint">↕ Lohista õpilase nimi teise rühma kaardile. Piirangut rikkuvat tõstmist ei lubata.</p>}<div className={`groups-grid ${drawMode === 'guided' ? 'groups-grid--guided' : ''}`}>{groups.map((group, groupIndex) => <article key={groupIndex} onDragOver={(event) => drawMode === 'guided' && event.preventDefault()} onDrop={() => drawMode === 'guided' && moveGroupMember(groupIndex)}><strong>Rühm {groupIndex + 1}</strong>{group.map((studentId) => { const student = studentById.get(studentId); return <span key={studentId} draggable={drawMode === 'guided'} onDragStart={() => setDraggedGroupMember({ studentId, fromGroup: groupIndex })} onDragEnd={() => setDraggedGroupMember(null)}>{drawMode === 'guided' && <b>⠿</b>}{student?.first_name} {student?.last_name}</span> })}</article>)}</div></> : <div className="preview-empty"><span>👥</span><h3>Loosi rühmad</h3><p>Märgi puudujad, vali rühma suurus ja vajuta „Loosi rühmad“.</p></div>}
            </div> : <div className="classroom-canvas">
              <div className="desk-grid" style={{ gridTemplateColumns: `repeat(${deskColumns}, minmax(110px, 1fr))` }}>
                {Array.from({ length: totalDeskCount }, (_, deskIndex) => disabledDesks.has(deskIndex)
                  ? <button className="desk-placeholder" key={deskIndex} onClick={() => toggleDesk(deskIndex)} title="Taasta laud"><span>+ Taasta laud</span></button>
                  : <div className={`desk desk--${capacityForDesk(deskIndex)}`} key={deskIndex}>
                    <button className="desk-remove" onClick={() => toggleDesk(deskIndex)} title="Eemalda laud" aria-label={`Eemalda laud ${deskIndex + 1}`}>×</button>
                    {deskType === 'mixed' && <button className="desk-size-toggle" onClick={() => cycleDeskCapacity(deskIndex)} title="Muuda laua kohtade arvu">{capacityForDesk(deskIndex)} kohta</button>}
                    {Array.from({ length: capacityForDesk(deskIndex) }, (_, position) => {
                      const seatIndex = deskIndex * seatsPerDesk + position
                      const studentId = assignments[seatIndex]
                      const student = studentId ? studentById.get(studentId) : null
                      return <div className={`seat ${studentId && lockedStudents.has(studentId) ? 'seat--locked' : ''}`} key={seatIndex} draggable={Boolean(student) && drawMode === 'guided'} onDragStart={() => setDraggedSeat(seatIndex)} onDragOver={(event) => drawMode === 'guided' && event.preventDefault()} onDrop={() => { if (draggedSeat !== null && draggedSeat !== seatIndex) moveStudent(draggedSeat, seatIndex); setDraggedSeat(null) }}>
                        {student && <><span>{student.first_name}<small>{student.last_name}</small></span>{drawMode === 'guided' && <button title={lockedStudents.has(student.id) ? 'Vabasta koht' : 'Lukusta koht'} onClick={() => toggleStudentLock(student.id)}>{lockedStudents.has(student.id) ? '🔒' : '○'}</button>}</>}
                      </div>
                    })}
                  </div>)}
              </div>
              {!planGenerated && <p className="canvas-hint">Eemalda vajaduse korral üleliigsed lauad ja vajuta seejärel „Loo isteplaan“.</p>}
              <div className="class-board"><span>TAHVEL</span></div>
            </div>}
            {resultGenerated && <div className="plan-finish"><label>Plaani nimi<input value={planName} onChange={(event) => setPlanName(event.target.value)} placeholder={`${plannerClass.name} ${activityType === 'groups' ? 'rühmad' : 'isteplaan'}`} /></label><div className="preview-actions"><button className="button button--ghost" onClick={() => { setAssignments([]); setGroups([]); setLockedStudents(new Set()) }}>Alusta uuesti</button>{editingPlanId && <button className="button button--ghost" onClick={saveCurrentAsNewPlan} disabled={savingPlan}>Salvesta uuena</button>}<button className="button button--ghost" onClick={savePlan} disabled={savingPlan}>{savingPlan ? 'Salvestan…' : editingPlanId ? 'Salvesta muudatused' : 'Salvesta plaan'}</button><button className="button" onClick={startPresentation}>Ava klassivaade →</button></div></div>}
          </section>
        </main>
      </div>}

      {presentationMode && plannerClass && <div className="presentation-view">
        <header><div><img className="presentation-logo" src={logoUrl} alt="Loo Kool" /><span><span className="eyebrow">{activityType === 'groups' ? 'Rühmade loosimine' : 'Kohtade loosimine'}</span><h1>{plannerClass.name}</h1></span></div><button onClick={() => { setPresentationMode(false); setDrawing(false) }}>×</button></header>
        <main className="presentation-room">
          {activityType === 'groups' ? <div className="presentation-groups">{groups.map((group, groupIndex) => <article key={groupIndex}><h2>Rühm {groupIndex + 1}</h2>{group.map((studentId) => { const student = studentById.get(studentId); const memberIndex = groups.flat().indexOf(studentId); const visible = memberIndex < revealCount; const rollingStudent = plannerStudents.length ? plannerStudents[(animationTick + memberIndex * 2) % plannerStudents.length] : null; const shown = visible ? student : drawing ? rollingStudent : null; return <span className={visible ? 'group-member--settled' : ''} key={studentId}>{shown ? `${shown.first_name} ${shown.last_name}` : ' '}</span> })}</article>)}</div> : <><div className="presentation-grid" style={{ gridTemplateColumns: `repeat(${deskColumns}, minmax(130px, 1fr))` }}>
            {Array.from({ length: totalDeskCount }, (_, deskIndex) => disabledDesks.has(deskIndex) ? <div key={deskIndex} /> : <div className={`presentation-desk presentation-desk--${capacityForDesk(deskIndex)}`} key={deskIndex}>
              {Array.from({ length: capacityForDesk(deskIndex) }, (_, position) => {
                const seatIndex = deskIndex * seatsPerDesk + position
                const studentId = assignments[seatIndex]
                const student = studentId ? studentById.get(studentId) : null
                const orderIndex = revealOrder.indexOf(seatIndex)
                const settled = orderIndex >= 0 && orderIndex < revealCount
                const rollingStudent = plannerStudents.length ? plannerStudents[(animationTick + seatIndex * 3) % plannerStudents.length] : null
                const visibleStudent = settled ? student : drawing ? rollingStudent : null
                return <div className={`presentation-seat ${settled ? 'presentation-seat--settled' : drawing ? 'presentation-seat--rolling' : ''}`} key={seatIndex}>{visibleStudent && <><strong>{visibleStudent.first_name}</strong><span>{visibleStudent.last_name}</span></>}</div>
              })}
            </div>)}
          </div><div className="presentation-board">TAHVEL</div></>}
        </main>
        <footer>{revealCount < presentationItemCount ? <button className="draw-start" onClick={beginDraw} disabled={drawing}>{drawing ? 'LOOSIMINE KÄIB…' : activityType === 'groups' ? '🎲 LOOSI RÜHMAD' : '🎲 LOOSI UUED KOHAD'}</button> : <><span>{activityType === 'groups' ? 'Rühmad on loositud!' : 'Kohad on loositud!'}</span><button className="button button--ghost" onClick={beginDraw}>Loosi uuesti</button><button className="button" onClick={() => window.print()}>↓ Ekspordi PDF</button></>}</footer>
      </div>}

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
    <div className="login-copy"><a className="brand brand--login" href={import.meta.env.BASE_URL}><span className="login-logo-card"><img className="school-logo" src={logoUrl} alt="Loo Kool" /></span><span>Isteplaan</span></a><span className="eyebrow">Õpetajate töövahend</span><h1>Paiguta klass rahulikult paika.</h1><p>Koosta juhitud või juhuslik isteplaan, määra sobimatud naabrid ning salvesta plaan järgmiseks korraks.</p><div className="feature-list"><span>✓ Klassid ja nimekirjad ühes kohas</span><span>✓ Õpetaja enda privaatsed plaanid</span><span>✓ Esitlusvaade ja PDF-eksport</span></div></div>
    <div className="login-form-wrap"><div className="login-form-header"><span className="icon-mail">✉</span><h2>Logi sisse</h2><p>Saadame sulle e-postiga ühekordse sisselogimislingi.</p></div>
      {!isSupabaseConfigured && <div className="notice notice--warning">Rakendus ootab veel Supabase’i publishable key seadistamist.</div>}
      <form onSubmit={sendMagicLink}><label htmlFor="email">Kooli e-post</label><input id="email" name="email" type="email" autoComplete="email" placeholder="eesnimi.perenimi@lookool.ee" value={email} onChange={(event) => setEmail(event.target.value)} required />{error && <div className="notice notice--error" role="alert">{error}</div>}{message && <div className="notice notice--success" role="status">{message}</div>}<button className="button button--wide" type="submit" disabled={submitting || !isSupabaseConfigured}>{submitting ? 'Saadan…' : 'Saada sisselogimislink'}</button></form>
      <p className="privacy-note">Sisse saavad ainult <strong>@lookool.ee</strong> kasutajad. Õpilaste andmeid ei jagata väljapoole kooli.</p>
    </div>
  </section></main>
}

export default App
