import type { FastifyPluginAsync } from "fastify";
import {
  AddLearningReportCardRemarkBody,
  AddLearningReportCardRemarkParams,
  GetLearningReportCardParams,
  GetLearningReportCardsQueryParams,
  PrepareLearningReportCardsBody,
  PublishLearningReportCardsBody,
} from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";
import { gradeForScore } from "../lib/learning-policy";
import { attendancePercent, escapeHtml } from "../lib/report-card-policy";

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];
const studentRoles: CampusRole[] = ["student"];
const parentRoles: CampusRole[] = ["parent"];
const defaultBands = [
  { grade: "A1", minPercent: 90 }, { grade: "A2", minPercent: 80 },
  { grade: "B1", minPercent: 70 }, { grade: "B2", minPercent: 60 },
  { grade: "C", minPercent: 50 }, { grade: "D", minPercent: 40 },
  { grade: "E", minPercent: 33 }, { grade: "F", minPercent: 0 },
];
const errorBody = (code: string, message: string) => ({ error: { code, message } });
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

type ReportCardRole = { admin: boolean; teacher: boolean; student: boolean; parent: boolean };
const roleFlags = (roles: CampusRole[]): ReportCardRole => ({
  admin: roles.some((role) => adminRoles.includes(role)),
  teacher: roles.some((role) => teacherRoles.includes(role)),
  student: roles.some((role) => studentRoles.includes(role)),
  parent: roles.some((role) => parentRoles.includes(role)),
});

async function canManageSection(client: any, orgId: string, userId: string, roles: CampusRole[], sectionId: string) {
  const flags = roleFlags(roles);
  if (flags.admin) {
    const exists = await client.query("SELECT 1 FROM academic.sections WHERE org_id=$1 AND id=$2", [orgId, sectionId]);
    return Boolean(exists.rowCount);
  }
  if (!flags.teacher) return false;
  const found = await client.query(
    `SELECT 1 FROM academic.sections s
      WHERE s.org_id=$1 AND s.id=$2
        AND (
          EXISTS (SELECT 1 FROM academic.section_teachers st
                   WHERE st.org_id=s.org_id AND st.section_id=s.id AND st.teacher_user_id=$3)
          OR EXISTS (SELECT 1 FROM academic.teacher_assignments ta
                      WHERE ta.org_id=s.org_id AND ta.section_id=s.id AND ta.teacher_user_id=$3)
        )`,
    [orgId, sectionId, userId],
  );
  return Boolean(found.rowCount);
}

async function hasSubjectAssignment(client: any, orgId: string, userId: string, sectionId: string, subjectId?: string | null) {
  const result = await client.query(
    `SELECT 1 FROM academic.teacher_assignments
      WHERE org_id=$1 AND teacher_user_id=$2 AND section_id=$3
        AND ($4::uuid IS NULL OR subject_id=$4)
      LIMIT 1`,
    [orgId, userId, sectionId, subjectId ?? null],
  );
  return Boolean(result.rowCount);
}

async function loadReportCards(client: any, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  const result = await client.query(
    `WITH cards AS (
       SELECT p.id, p.student_user_id, p.section_id, p.term_id, p.published, p.published_at,
              u.name AS student_name, e.admission_no, s.name AS section_name, t.name AS term_name,
              t.starts_on, t.ends_on
         FROM learning.report_card_publications p
         JOIN identity.users u ON u.org_id=p.org_id AND u.id=p.student_user_id
         JOIN LATERAL (
           SELECT admission_no FROM academic.enrollments
            WHERE org_id=p.org_id AND student_user_id=p.student_user_id AND section_id=p.section_id
            ORDER BY created_at DESC LIMIT 1
         ) e ON true
         JOIN academic.sections s ON s.org_id=p.org_id AND s.id=p.section_id
         JOIN learning.exam_terms t ON t.org_id=p.org_id AND t.id=p.term_id
        WHERE p.org_id=$1 AND p.id=ANY($2::uuid[])
     ),
     groups AS (
       SELECT DISTINCT section_id, term_id FROM cards
     ),
     active_students AS (
       SELECT DISTINCT org_id, section_id, student_user_id
         FROM academic.enrollments WHERE org_id=$1 AND status='active'
     ),
     published_marks AS (
       SELECT c.id AS card_id, ex.subject_id, sub.name AS subject_name, m.score, ex.max_points
         FROM cards c
         JOIN learning.exams ex ON ex.org_id=$1 AND ex.section_id=c.section_id
                               AND ex.term_id=c.term_id AND ex.status='published'
         JOIN learning.exam_marks m ON m.org_id=ex.org_id AND m.exam_id=ex.id
                                   AND m.student_user_id=c.student_user_id
         LEFT JOIN academic.subjects sub ON sub.org_id=ex.org_id AND sub.id=ex.subject_id
     ),
     subject_totals AS (
       SELECT card_id, subject_id, subject_name, SUM(score)::numeric AS score,
              SUM(max_points)::numeric AS max_points
         FROM published_marks
        WHERE subject_id IS NOT NULL
        GROUP BY card_id, subject_id, subject_name
     ),
     overall_totals AS (
       SELECT card_id, SUM(score)::numeric AS score, SUM(max_points)::numeric AS max_points
         FROM published_marks GROUP BY card_id
     ),
     student_totals AS (
       SELECT g.section_id, g.term_id, e.student_user_id, SUM(m.score)::numeric AS score,
              SUM(ex.max_points)::numeric AS max_points
         FROM groups g
         JOIN active_students e ON e.org_id=$1 AND e.section_id=g.section_id
         JOIN learning.exams ex ON ex.org_id=$1 AND ex.section_id=g.section_id
                               AND ex.term_id=g.term_id AND ex.status='published'
         JOIN learning.exam_marks m ON m.org_id=ex.org_id AND m.exam_id=ex.id
                                   AND m.student_user_id=e.student_user_id
        GROUP BY g.section_id, g.term_id, e.student_user_id
     ),
     ranked AS (
       SELECT section_id, term_id, student_user_id,
              RANK() OVER (PARTITION BY section_id, term_id ORDER BY score / NULLIF(max_points, 0) DESC)::integer AS rank
         FROM student_totals
     ),
     attendance AS (
       SELECT c.id AS card_id,
              COUNT(DISTINCT ses.attendance_date) FILTER (WHERE mark.status IN ('present','late'))::integer AS attended_days,
              COUNT(DISTINCT ses.attendance_date) FILTER (WHERE mark.status IN ('present','absent','late'))::integer AS counted_days
         FROM cards c
         LEFT JOIN school.attendance_sessions ses ON ses.org_id=$1 AND ses.section_id=c.section_id
             AND ses.period IS NULL AND ses.attendance_date BETWEEN c.starts_on AND c.ends_on
         LEFT JOIN school.attendance_marks mark ON mark.org_id=ses.org_id AND mark.session_id=ses.id
             AND mark.student_user_id=c.student_user_id
        GROUP BY c.id
     )
     SELECT c.id, c.student_user_id, c.student_name, c.admission_no, c.section_id, c.section_name,
            c.term_id, c.term_name, c.published, c.published_at,
            ot.score AS overall_score, ot.max_points AS overall_max_points,
            ranked.rank,
            (SELECT COUNT(DISTINCT e.student_user_id)::integer FROM active_students e
              WHERE e.org_id=$1 AND e.section_id=c.section_id) AS total_students,
            COALESCE(att.attended_days,0)::integer AS attended_days,
            COALESCE(att.counted_days,0)::integer AS counted_days,
            (SELECT r.remark FROM learning.report_card_remarks r
              WHERE r.org_id=$1 AND r.student_user_id=c.student_user_id
                AND r.term_id=c.term_id AND r.subject_id IS NULL LIMIT 1) AS general_remark,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'subjectId', st.subject_id,
                'subjectName', st.subject_name,
                'score', st.score,
                'maxPoints', st.max_points,
                'remark', remark.remark
              ) ORDER BY st.subject_name)
                FROM subject_totals st
                LEFT JOIN learning.report_card_remarks remark
                  ON remark.org_id=$1 AND remark.student_user_id=c.student_user_id
                 AND remark.term_id=c.term_id AND remark.subject_id=st.subject_id
               WHERE st.card_id=c.id
            ), '[]'::jsonb) AS subjects
       FROM cards c
       LEFT JOIN overall_totals ot ON ot.card_id=c.id
       LEFT JOIN ranked ON ranked.section_id=c.section_id AND ranked.term_id=c.term_id
                       AND ranked.student_user_id=c.student_user_id
       LEFT JOIN attendance att ON att.card_id=c.id
      ORDER BY c.student_name, c.id`,
    [orgId, ids],
  );
  const bandsResult = await client.query("SELECT bands FROM learning.grade_scales WHERE org_id=$1", [orgId]);
  const bands = (bandsResult.rows[0]?.bands as { grade: string; minPercent: number }[] | undefined) ?? defaultBands;
  return result.rows.map((row: any) => {
    const score = row.overall_score == null ? null : Number(row.overall_score);
    const maxPoints = row.overall_max_points == null ? null : Number(row.overall_max_points);
    const attendedDays = Number(row.attended_days ?? 0);
    const countedDays = Number(row.counted_days ?? 0);
    const rawSubjects = Array.isArray(row.subjects) ? row.subjects : [];
    const subjects = rawSubjects.map((subject: any) => {
      const subjectScore = Number(subject.score);
      const subjectMax = Number(subject.maxPoints);
      return {
        subjectId: subject.subjectId,
        subjectName: subject.subjectName ?? "Subject",
        score: subjectScore,
        maxPoints: subjectMax,
        percent: subjectMax > 0 ? round2((subjectScore / subjectMax) * 100) : 0,
        grade: gradeForScore(subjectScore, subjectMax, bands) ?? "—",
        remark: subject.remark ?? null,
      };
    });
    return {
      id: row.id,
      studentId: row.student_user_id,
      studentName: row.student_name,
      admissionNo: row.admission_no,
      sectionId: row.section_id,
      sectionName: row.section_name,
      termId: row.term_id,
      termName: row.term_name,
      published: row.published,
      publishedAt: row.published_at,
      overallPercent: score != null && maxPoints != null && maxPoints > 0 ? round2((score / maxPoints) * 100) : null,
      overallGrade: score != null && maxPoints != null ? gradeForScore(score, maxPoints, bands) : null,
      rank: row.rank == null ? null : Number(row.rank),
      totalStudents: Number(row.total_students ?? 0),
      attendancePercent: attendancePercent(attendedDays, countedDays),
      attendedDays,
      countedDays,
      generalRemark: row.general_remark ?? null,
      subjects,
    };
  });
}

async function audit(client: any, orgId: string, actorId: string, action: string, resourceId: string, metadata: object = {}) {
  await client.query(
    `INSERT INTO learning.audit_log (org_id, actor_user_id, action, resource_type, resource_id, metadata)
     VALUES ($1,$2,$3,'report_card',$4,$5::jsonb)`,
    [orgId, actorId, action, resourceId, JSON.stringify(metadata)],
  );
}

function renderPrintableReportCard(card: any) {
  const subjectRows = card.subjects.map((subject: any) => `
    <tr><td>${escapeHtml(subject.subjectName)}</td><td>${subject.score}</td><td>${subject.maxPoints}</td>
    <td>${subject.percent.toFixed(2)}%</td><td>${escapeHtml(subject.grade)}</td><td>${escapeHtml(subject.remark ?? "")}</td></tr>`).join("");
  const attendanceText = card.attendancePercent == null ? "No attendance recorded" : `${card.attendancePercent.toFixed(2)}% (${card.attendedDays}/${card.countedDays} days)`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${escapeHtml(card.studentName)} — ${escapeHtml(card.termName)} report</title>
    <style>
      @page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:14px/1.45 Arial,sans-serif;color:#15212b;margin:0}
      h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.muted{color:#566573}
      .header{border-bottom:2px solid #173b53;padding-bottom:14px}.identity{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px 0}
      .stat{border:1px solid #d5dee5;padding:10px}.stat strong{display:block;font-size:17px;margin-top:4px}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccd6dd;padding:8px;text-align:left}th{background:#f1f5f7}
      .remark{white-space:pre-wrap;border:1px solid #ccd6dd;padding:12px;min-height:54px}.actions{margin:16px 0}
      @media print{.actions{display:none}body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
    </style></head><body>
    <div class="actions">Use your browser's print command to print this report card.</div>
    <header class="header"><p class="muted">Campus Live · Term report</p><h1>${escapeHtml(card.termName)}</h1><p class="muted">${escapeHtml(card.sectionName)}</p></header>
    <section class="identity"><div><span class="muted">Student</span><strong>${escapeHtml(card.studentName)}</strong></div>
      <div><span class="muted">Admission number</span><strong>${escapeHtml(card.admissionNo)}</strong></div></section>
    <section class="identity"><div class="stat">Overall percentage<strong>${card.overallPercent == null ? "—" : `${card.overallPercent.toFixed(2)}%`}</strong></div>
      <div class="stat">Grade<strong>${escapeHtml(card.overallGrade ?? "—")}</strong></div>
      <div class="stat">Section rank<strong>${card.rank == null ? "—" : `${card.rank} / ${card.totalStudents}`}</strong></div>
      <div class="stat">Attendance<strong>${escapeHtml(attendanceText)}</strong></div></section>
    <h2>Subject results</h2><table><thead><tr><th>Subject</th><th>Score</th><th>Maximum</th><th>Percent</th><th>Grade</th><th>Remark</th></tr></thead>
      <tbody>${subjectRows || '<tr><td colspan="6">No published subject results for this term.</td></tr>'}</tbody></table>
    <h2>Teacher remark</h2><div class="remark">${escapeHtml(card.generalRemark ?? "")}</div>
    </body></html>`;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);

  router.get("/learning/report-cards", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const query = GetLearningReportCardsQueryParams.safeParse(req.query);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!query.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid report-card filters."));
    const roles = roleFlags(user.roles);
    try {
      const cards = await withOrg(user.orgId, async (client) => {
        let ids: string[];
        if (roles.admin || roles.teacher) {
          if (!query.data.sectionId || !query.data.termId) return { invalid: true as const };
          const allowed = await canManageSection(client, user.orgId, user.id, user.roles, query.data.sectionId);
          if (!allowed) return { forbidden: true as const };
          const result = await client.query(
            `SELECT id FROM learning.report_card_publications
              WHERE org_id=$1 AND section_id=$2 AND term_id=$3
              ORDER BY student_user_id`,
            [user.orgId, query.data.sectionId, query.data.termId],
          );
          ids = result.rows.map((row: any) => row.id);
        } else if (roles.student || roles.parent) {
          const result = await client.query(
            `SELECT p.id
               FROM learning.report_card_publications p
              WHERE p.org_id=$1 AND p.published=true
                AND ($2::uuid IS NULL OR p.section_id=$2)
                AND ($3::uuid IS NULL OR p.term_id=$3)
                AND (
                  ($4::boolean AND p.student_user_id=$5)
                  OR ($6::boolean AND EXISTS (
                    SELECT 1 FROM identity.guardian_links gl
                     WHERE gl.org_id=p.org_id AND gl.guardian_user_id=$5
                       AND gl.student_user_id=p.student_user_id
                  ))
                )
              ORDER BY p.term_id DESC, p.student_user_id`,
            [user.orgId, query.data.sectionId ?? null, query.data.termId ?? null, roles.student, user.id, roles.parent],
          );
          ids = result.rows.map((row: any) => row.id);
        } else {
          return { forbidden: true as const };
        }
        return { items: await loadReportCards(client, user.orgId, ids) };
      });
      if ("invalid" in cards) return void res.status(400).json(errorBody("INVALID_REQUEST", "Select a section and term to view report cards."));
      if ("forbidden" in cards) return void res.status(403).json(errorBody("FORBIDDEN", "You do not have access to these report cards."));
      res.json({ items: cards.items, total: cards.items.length });
    } catch (error) { next(error); }
  });

  router.post("/learning/report-cards", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const parsed = PrepareLearningReportCardsBody.safeParse(req.body);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Select a valid section and term."));
    if (!roleFlags(user.roles).admin && !roleFlags(user.roles).teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only school staff can prepare report cards."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        if (!await canManageSection(client, user.orgId, user.id, user.roles, parsed.data.sectionId)) return { forbidden: true as const };
        const term = await client.query("SELECT 1 FROM learning.exam_terms WHERE org_id=$1 AND id=$2", [user.orgId, parsed.data.termId]);
        if (!term.rowCount) return { invalid: true as const };
        await client.query(
          `INSERT INTO learning.report_card_publications (org_id, student_user_id, section_id, term_id)
           SELECT $1, e.student_user_id, e.section_id, $3
             FROM academic.enrollments e
            WHERE e.org_id=$1 AND e.section_id=$2 AND e.status='active'
           ON CONFLICT (org_id, student_user_id, term_id)
           DO UPDATE SET section_id=EXCLUDED.section_id, updated_at=now()
             WHERE learning.report_card_publications.published=false`,
          [user.orgId, parsed.data.sectionId, parsed.data.termId],
        );
        const ids = await client.query(
          `SELECT id FROM learning.report_card_publications
            WHERE org_id=$1 AND section_id=$2 AND term_id=$3
            ORDER BY student_user_id`,
          [user.orgId, parsed.data.sectionId, parsed.data.termId],
        );
        await audit(client, user.orgId, user.id, "report_cards.prepared", parsed.data.termId, { sectionId: parsed.data.sectionId, count: ids.rowCount ?? 0 });
        return { items: await loadReportCards(client, user.orgId, ids.rows.map((row: any) => row.id)) };
      });
      if ("forbidden" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You do not have access to this section."));
      if ("invalid" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Term not found."));
      res.status(201).json({ items: result.items, total: result.items.length });
    } catch (error) { next(error); }
  });

  router.post("/learning/report-cards/publish", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const parsed = PublishLearningReportCardsBody.safeParse(req.body);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid publication request."));
    if (!roleFlags(user.roles).admin && !roleFlags(user.roles).teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only school staff can publish report cards."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        if (!await canManageSection(client, user.orgId, user.id, user.roles, parsed.data.sectionId)) return { forbidden: true as const };
        const term = await client.query("SELECT 1 FROM learning.exam_terms WHERE org_id=$1 AND id=$2", [user.orgId, parsed.data.termId]);
        if (!term.rowCount) return { invalid: true as const };
        await client.query(
          `INSERT INTO learning.report_card_publications (org_id, student_user_id, section_id, term_id)
           SELECT $1, e.student_user_id, e.section_id, $3
             FROM academic.enrollments e
            WHERE e.org_id=$1 AND e.section_id=$2 AND e.status='active'
           ON CONFLICT (org_id, student_user_id, term_id)
           DO UPDATE SET section_id=EXCLUDED.section_id, updated_at=now()
             WHERE learning.report_card_publications.published=false`,
          [user.orgId, parsed.data.sectionId, parsed.data.termId],
        );
        await client.query(
          `UPDATE learning.report_card_publications
              SET published=$4,
                  published_by=CASE WHEN $4 THEN $5 ELSE NULL END,
                  published_at=CASE WHEN $4 THEN COALESCE(published_at,now()) ELSE NULL END,
                  updated_at=now()
            WHERE org_id=$1 AND section_id=$2 AND term_id=$3`,
          [user.orgId, parsed.data.sectionId, parsed.data.termId, parsed.data.published, user.id],
        );
        const ids = await client.query(
          `SELECT id FROM learning.report_card_publications
            WHERE org_id=$1 AND section_id=$2 AND term_id=$3
            ORDER BY student_user_id`,
          [user.orgId, parsed.data.sectionId, parsed.data.termId],
        );
        await audit(client, user.orgId, user.id, parsed.data.published ? "report_cards.published" : "report_cards.withdrawn",
          parsed.data.termId, { sectionId: parsed.data.sectionId, count: ids.rowCount ?? 0 });
        return { items: await loadReportCards(client, user.orgId, ids.rows.map((row: any) => row.id)) };
      });
      if ("forbidden" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You do not have access to this section."));
      if ("invalid" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Term not found."));
      res.json({ items: result.items, total: result.items.length });
    } catch (error) { next(error); }
  });

  router.get("/learning/report-cards/:reportCardId", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const params = GetLearningReportCardParams.safeParse(req.params);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid report-card ID."));
    try {
      const card = await withOrg(user.orgId, async (client) => {
        const found = await client.query(
          `SELECT id, student_user_id, section_id, published
             FROM learning.report_card_publications WHERE org_id=$1 AND id=$2`,
          [user.orgId, params.data.reportCardId],
        );
        if (!found.rowCount) return null;
        const record = found.rows[0];
        const roles = roleFlags(user.roles);
        const visible = roles.admin
          || (roles.teacher && await canManageSection(client, user.orgId, user.id, user.roles, record.section_id))
          || (record.published && roles.student && record.student_user_id === user.id)
          || (record.published && roles.parent && Boolean((await client.query(
            `SELECT 1 FROM identity.guardian_links
              WHERE org_id=$1 AND guardian_user_id=$2 AND student_user_id=$3`,
            [user.orgId, user.id, record.student_user_id],
          )).rowCount));
        if (!visible) return null;
        return (await loadReportCards(client, user.orgId, [params.data.reportCardId]))[0] ?? null;
      });
      if (!card) return void res.status(404).json(errorBody("NOT_FOUND", "Report card not found."));
      res.json(card);
    } catch (error) { next(error); }
  });

  router.post("/learning/report-cards/:reportCardId/remark", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const params = AddLearningReportCardRemarkParams.safeParse(req.params);
    const parsed = AddLearningReportCardRemarkBody.safeParse(req.body);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!params.success || !parsed.success || !parsed.data.remark.trim()) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid report-card remark."));
    if (!roleFlags(user.roles).admin && !roleFlags(user.roles).teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only school staff can add report-card remarks."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        const record = await client.query(
          `SELECT student_user_id, section_id, term_id, published
             FROM learning.report_card_publications WHERE org_id=$1 AND id=$2`,
          [user.orgId, params.data.reportCardId],
        );
        if (!record.rowCount) return { missing: true as const };
        const card = record.rows[0];
        const flags = roleFlags(user.roles);
        if (!flags.admin && !await canManageSection(client, user.orgId, user.id, user.roles, card.section_id)) return { forbidden: true as const };
        if (card.published) return { published: true as const };
        const subjectId = parsed.data.subjectId ?? null;
        if (subjectId) {
          const subjectInReport = await client.query(
            `SELECT 1 FROM learning.exams ex
             WHERE ex.org_id=$1 AND ex.section_id=$2 AND ex.term_id=$3
               AND ex.subject_id=$4 AND ex.status='published' LIMIT 1`,
            [user.orgId, card.section_id, card.term_id, subjectId],
          );
          if (!subjectInReport.rowCount) return { invalidSubject: true as const };
        }
        if (!flags.admin && !(subjectId
          ? await hasSubjectAssignment(client, user.orgId, user.id, card.section_id, subjectId)
          : await canManageSection(client, user.orgId, user.id, user.roles, card.section_id))) {
          return { forbidden: true as const };
        }
        const conflictTarget = subjectId
          ? "(org_id, student_user_id, term_id, subject_id) WHERE subject_id IS NOT NULL"
          : "(org_id, student_user_id, term_id) WHERE subject_id IS NULL";
        await client.query(
          `INSERT INTO learning.report_card_remarks (org_id, student_user_id, term_id, subject_id, remark, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT ${conflictTarget}
           DO UPDATE SET remark=EXCLUDED.remark, created_by=EXCLUDED.created_by, updated_at=now()`,
          [user.orgId, card.student_user_id, card.term_id, subjectId, parsed.data.remark.trim(), user.id],
        );
        await audit(client, user.orgId, user.id, "report_card.remark_updated", params.data.reportCardId, { subjectId });
        return { card: (await loadReportCards(client, user.orgId, [params.data.reportCardId]))[0] };
      });
      if ("missing" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Report card not found."));
      if ("forbidden" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You do not have permission to add this remark."));
      if ("published" in result) return void res.status(409).json(errorBody("REPORT_PUBLISHED", "Withdraw this report card before editing remarks."));
      if ("invalidSubject" in result) return void res.status(400).json(errorBody("INVALID_SUBJECT", "The subject has no published result on this report card."));
      res.json(result.card);
    } catch (error) { next(error); }
  });

  router.get("/learning/report-cards/:reportCardId/print", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const params = GetLearningReportCardParams.safeParse(req.params);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid report-card ID."));
    try {
      const card = await withOrg(user.orgId, async (client) => {
        const found = await client.query(
          `SELECT student_user_id, section_id, published FROM learning.report_card_publications
            WHERE org_id=$1 AND id=$2`,
          [user.orgId, params.data.reportCardId],
        );
        if (!found.rowCount) return null;
        const record = found.rows[0];
        const flags = roleFlags(user.roles);
        const allowed = flags.admin
          || (flags.teacher && await canManageSection(client, user.orgId, user.id, user.roles, record.section_id))
          || (record.published && flags.student && record.student_user_id === user.id)
          || (record.published && flags.parent && Boolean((await client.query(
            `SELECT 1 FROM identity.guardian_links
              WHERE org_id=$1 AND guardian_user_id=$2 AND student_user_id=$3`,
            [user.orgId, user.id, record.student_user_id],
          )).rowCount));
        return allowed ? (await loadReportCards(client, user.orgId, [params.data.reportCardId]))[0] ?? null : null;
      });
      if (!card) return void res.status(404).json(errorBody("NOT_FOUND", "Report card not found."));
      res.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.header("X-Content-Type-Options", "nosniff");
      res.type("text/html; charset=utf-8").send(renderPrintableReportCard(card));
    } catch (error) { next(error); }
  });
};

export default routes;
