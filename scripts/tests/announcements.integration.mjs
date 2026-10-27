import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const apiBase = new URL(process.env.ANNOUNCEMENTS_API_URL ?? "http://127.0.0.1:8080/api");
if (!["127.0.0.1", "localhost", "::1"].includes(apiBase.hostname)) {
  throw new Error("Announcements integration tests may only call a loopback API server.");
}
const devSecret = "campus-live-development-jwt-secret-not-for-production";
const createdIds = [];
let orgId = null;

function tokenFor(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    ...user,
    iss: "campus-live-identity",
    aud: "campus-live-web",
    iat: now,
    exp: now + 900,
    sub: user.id,
  })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", process.env.JWT_SECRET ?? devSecret).update(content).digest("base64url")}`;
}

async function api(method, path, user, body) {
  const response = await fetch(`${apiBase.toString().replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      ...(user ? { authorization: `Bearer ${tokenFor(user)}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}

async function withOrg(organizationId, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [organizationId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

after(async () => {
  if (orgId && createdIds.length) {
    await withOrg(orgId, (client) =>
      client.query("DELETE FROM school.announcements WHERE org_id=$1 AND id=ANY($2::uuid[])", [orgId, createdIds]),
    );
  }
  await pool.end();
});

test("announcements publish, respect audiences, and record read receipts", {
  skip: process.env.RUN_ANNOUNCEMENTS_INTEGRATION !== "1",
  timeout: 60_000,
}, async (t) => {
  const role = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
  assert.equal(role.rows[0]?.rolsuper, false);
  assert.equal(role.rows[0]?.rolbypassrls, false);
  const organization = (await pool.query("SELECT id FROM identity.organizations ORDER BY created_at LIMIT 1")).rows[0];
  if (!organization) return t.skip("A seeded organization is required.");
  orgId = organization.id;

  const people = await withOrg(orgId, async (client) => {
    const admins = await client.query(
      `SELECT u.id, u.name, u.email, array_agg(ur.role ORDER BY ur.role) AS roles
         FROM identity.users u JOIN identity.user_roles ur ON ur.org_id=u.org_id AND ur.user_id=u.id
        WHERE u.org_id=$1 AND ur.role = ANY($2::text[])
        GROUP BY u.id ORDER BY u.created_at LIMIT 1`,
      [orgId, ["super_admin", "org_admin", "campus_admin"]],
    );
    const group = await client.query(
      `WITH teaching AS (
         SELECT org_id, section_id, teacher_user_id FROM academic.section_teachers
         UNION
         SELECT org_id, section_id, teacher_user_id FROM academic.teacher_assignments
       )
       SELECT teacher.id AS teacher_id, teacher.name AS teacher_name, teacher.email AS teacher_email,
              array_agg(DISTINCT teacher_role.role ORDER BY teacher_role.role) AS teacher_roles,
              student.id AS student_id, student.name AS student_name, student.email AS student_email,
              array_agg(DISTINCT student_role.role ORDER BY student_role.role) AS student_roles,
              teaching.section_id,
              parent.id AS parent_id, parent.name AS parent_name, parent.email AS parent_email,
              array_agg(DISTINCT parent_role.role ORDER BY parent_role.role)
                FILTER (WHERE parent_role.role IS NOT NULL) AS parent_roles
         FROM teaching
         JOIN identity.users teacher ON teacher.org_id=teaching.org_id AND teacher.id=teaching.teacher_user_id
         JOIN identity.user_roles teacher_role ON teacher_role.org_id=teacher.org_id AND teacher_role.user_id=teacher.id
         JOIN academic.enrollments e ON e.org_id=teaching.org_id AND e.section_id=teaching.section_id AND e.status='active'
         JOIN identity.users student ON student.org_id=e.org_id AND student.id=e.student_user_id
         JOIN identity.user_roles student_role ON student_role.org_id=student.org_id AND student_role.user_id=student.id
         LEFT JOIN identity.guardian_links gl ON gl.org_id=e.org_id AND gl.student_user_id=e.student_user_id
         LEFT JOIN identity.users parent ON parent.org_id=gl.org_id AND parent.id=gl.guardian_user_id
         LEFT JOIN identity.user_roles parent_role ON parent_role.org_id=parent.org_id AND parent_role.user_id=parent.id
        WHERE teaching.org_id=$1 AND teacher_role.role = ANY($2::text[]) AND student_role.role='student'
        GROUP BY teacher.id, student.id, teaching.section_id, parent.id
        ORDER BY teacher.id, student.id LIMIT 1`,
      [orgId, ["teacher", "class_teacher", "hod"]],
    );
    const extraSection = await client.query(
      "SELECT id FROM academic.sections WHERE org_id=$1 ORDER BY id LIMIT 1",
      [orgId],
    );
    return { admin: admins.rows[0], group: group.rows[0], otherSectionId: extraSection.rows[0]?.id };
  });
  if (!people.admin || !people.group) return t.skip("Seeded admin, teacher, and active student assignment are required.");

  const userFrom = (id, name, email, roles) => ({ id, orgId, name, email, roles, mustChangePassword: false });
  const admin = userFrom(people.admin.id, people.admin.name, people.admin.email, people.admin.roles);
  const teacher = userFrom(people.group.teacher_id, people.group.teacher_name, people.group.teacher_email, people.group.teacher_roles);
  const student = userFrom(people.group.student_id, people.group.student_name, people.group.student_email, people.group.student_roles);
  const parent = people.group.parent_id
    ? userFrom(people.group.parent_id, people.group.parent_name, people.group.parent_email, people.group.parent_roles)
    : null;

  const unauthorized = await api("GET", "/announcements", null);
  assert.equal(unauthorized.status, 401);
  const emptyRoleAudience = await api("POST", "/announcements", admin, {
    title: `Invalid role targeting ${randomUUID().slice(0, 6)}`,
    body: "Role-targeted announcements need at least one role.",
    audience: "role",
    roles: [],
  });
  assert.equal(emptyRoleAudience.status, 400);

  const title = `Integration announcement ${randomUUID().slice(0, 8)}`;
  const published = await api("POST", "/announcements", admin, {
    title,
    body: "An integration-test school announcement.",
    audience: "school",
    priority: "urgent",
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  createdIds.push(published.body.id);
  assert.equal(published.body.title, title);
  assert.equal(published.body.priority, "urgent");

  const studentFeed = await api("GET", "/announcements", student);
  assert.equal(studentFeed.status, 200, JSON.stringify(studentFeed.body));
  assert.ok(studentFeed.body.items.some((item) => item.id === published.body.id));

  if (parent) {
    const parentFeed = await api("GET", "/announcements", parent);
    assert.equal(parentFeed.status, 200, JSON.stringify(parentFeed.body));
    assert.ok(parentFeed.body.items.some((item) => item.id === published.body.id));

    const parentOnly = await api("POST", "/announcements", admin, {
      title: `Parent update ${randomUUID().slice(0, 8)}`,
      body: "This is intended for parent accounts.",
      audience: "role",
      roles: ["parent"],
    });
    assert.equal(parentOnly.status, 201, JSON.stringify(parentOnly.body));
    createdIds.push(parentOnly.body.id);
    assert.ok(parentFeed.body.items.every((item) => item.id !== parentOnly.body.id));
    const refreshedParentFeed = await api("GET", "/announcements", parent);
    assert.ok(refreshedParentFeed.body.items.some((item) => item.id === parentOnly.body.id));
    const refreshedStudentFeed = await api("GET", "/announcements", student);
    assert.ok(refreshedStudentFeed.body.items.every((item) => item.id !== parentOnly.body.id));
  }

  const teacherCannotPublishSchoolwide = await api("POST", "/announcements", teacher, {
    title: `Teacher denied ${randomUUID().slice(0, 6)}`,
    body: "Teachers cannot publish school-wide announcements.",
    audience: "school",
  });
  assert.equal(teacherCannotPublishSchoolwide.status, 403);

  const sectionAnnouncement = await api("POST", "/announcements", teacher, {
    title: `Section announcement ${randomUUID().slice(0, 8)}`,
    body: "This announcement is only for the assigned section.",
    audience: "section",
    audienceId: people.group.section_id,
  });
  assert.equal(sectionAnnouncement.status, 201, JSON.stringify(sectionAnnouncement.body));
  createdIds.push(sectionAnnouncement.body.id);

  const sectionStudentFeed = await api("GET", "/announcements", student);
  assert.ok(sectionStudentFeed.body.items.some((item) => item.id === sectionAnnouncement.body.id));
  if (parent) {
    const sectionParentFeed = await api("GET", "/announcements", parent);
    assert.ok(sectionParentFeed.body.items.some((item) => item.id === sectionAnnouncement.body.id));
  }

  const read = await api("POST", `/announcements/${published.body.id}/read`, student);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(read.body.readAt);
  const readAgain = await api("POST", `/announcements/${published.body.id}/read`, student);
  assert.equal(readAgain.status, 200);
  assert.equal(readAgain.body.readAt, read.body.readAt);

  const unread = await api("GET", "/announcements?unread=true", student);
  assert.equal(unread.status, 200, JSON.stringify(unread.body));
  assert.ok(!unread.body.items.some((item) => item.id === published.body.id));

  const sectionRead = await api("POST", `/announcements/${sectionAnnouncement.body.id}/read`, student);
  assert.equal(sectionRead.status, 200, JSON.stringify(sectionRead.body));
  const stats = await api("GET", `/announcements/${sectionAnnouncement.body.id}/stats`, teacher);
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  assert.ok(stats.body.total >= 1);
  const studentStats = await api("GET", `/announcements/${published.body.id}/stats`, student);
  assert.equal(studentStats.status, 403);

  if (people.otherSectionId && people.otherSectionId !== people.group.section_id) {
    const wrongSection = await api("POST", "/announcements", teacher, {
      title: `Out of scope ${randomUUID().slice(0, 6)}`,
      body: "This write must be denied.",
      audience: "section",
      audienceId: people.otherSectionId,
    });
    assert.equal(wrongSection.status, 403);
  }
});
