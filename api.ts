import type { Config } from "@netlify/functions";
import { eq, desc, count } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  students,
  prokerEvaluations,
  surveys,
  adminSettings,
} from "../../db/schema.js";
import fs from "node:fs";
import path from "node:path";

// Load bundled student database for instant seeding/fallback
let cachedStudents: Array<{
  nis: string;
  name: string;
  studentClass: string;
  attendance: string;
  gender: string;
  grade: string;
  password: string;
}> = [];

try {
  const jsonPath = path.resolve(process.cwd(), "db/students.json");
  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    cachedStudents = JSON.parse(raw);
  }
} catch (e) {
  console.warn("Could not load cached students.json:", e);
}

// Resilient local JSON helpers for fallback/cache
function getLocalJson(file: string, def: any) {
  try {
    const p = path.join("/tmp", file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  return def;
}

function setLocalJson(file: string, val: any) {
  try {
    const p = path.join("/tmp", file);
    fs.writeFileSync(p, JSON.stringify(val), "utf-8");
  } catch {}
}

let seeded = false;
async function ensureDbSeeded() {
  if (seeded) return;
  try {
    const res = await db.select({ total: count() }).from(students);
    const total = Number(res[0]?.total || 0);
    if (total === 0 && cachedStudents.length > 0) {
      console.log(`Seeding ${cachedStudents.length} students into database...`);
      for (let i = 0; i < cachedStudents.length; i += 100) {
        const chunk = cachedStudents.slice(i, i + 100);
        await db
          .insert(students)
          .values(
            chunk.map((s) => ({
              nis: s.nis,
              name: s.name,
              studentClass: s.studentClass,
              attendance: s.attendance || "-",
              gender: s.gender || "-",
              grade: s.grade,
              password: s.password || s.nis,
            }))
          )
          .onConflictDoNothing();
      }
    }

    const adminRes = await db.select({ total: count() }).from(adminSettings);
    if (Number(adminRes[0]?.total || 0) === 0) {
      await db
        .insert(adminSettings)
        .values({ username: "admin", password: "admin123" })
        .onConflictDoNothing();
    }

    seeded = true;
  } catch (err) {
    // When DB is initializing or migrating, continue gracefully
  }
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const jsonResponse = (data: unknown, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  };

  try {
    await ensureDbSeeded();

    // 1. Student Login: POST /api/student/login
    if (pathname.endsWith("/api/student/login") && method === "POST") {
      const body = await req.json();
      const nis = String(body.nisn || body.nis || "").trim();
      const password = String(body.password || "").trim();

      if (!nis || !password) {
        return jsonResponse(
          { success: false, message: "NIS dan password wajib diisi." },
          400
        );
      }

      // Check in DB
      let user = null;
      try {
        const rows = await db
          .select()
          .from(students)
          .where(eq(students.nis, nis));
        if (rows.length > 0) user = rows[0];
      } catch (err) {}

      // If not yet in DB, check cachedStudents list
      if (!user) {
        const cached = cachedStudents.find((s) => s.nis === nis);
        if (cached) {
          user = {
            id: 0,
            nis: cached.nis,
            name: cached.name,
            studentClass: cached.studentClass,
            attendance: cached.attendance,
            gender: cached.gender,
            grade: cached.grade,
            password: cached.password,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          // Try inserting into DB in background
          try {
            await db
              .insert(students)
              .values({
                nis: cached.nis,
                name: cached.name,
                studentClass: cached.studentClass,
                attendance: cached.attendance,
                gender: cached.gender,
                grade: cached.grade,
                password: cached.password,
              })
              .onConflictDoNothing();
          } catch {}
        }
      }

      // Check for custom password in local fallback if not in DB
      const localPasswordMap = getLocalJson("student_passwords.json", {});
      const effectivePassword = localPasswordMap[nis] || (user ? user.password : null);

      if (!user) {
        return jsonResponse(
          { success: false, message: "NIS tidak terdaftar dalam sistem." },
          401
        );
      }

      if (effectivePassword !== password) {
        return jsonResponse(
          { success: false, message: "Password salah. Silakan coba lagi." },
          401
        );
      }

      return jsonResponse({
        success: true,
        student: {
          nisn: user.nis,
          nis: user.nis,
          name: user.name,
          studentClass: user.studentClass,
          attendance: user.attendance,
          gender: user.gender,
          grade: user.grade,
        },
      });
    }

    // 2. Student Change Password: POST /api/student/change-password
    if (pathname.endsWith("/api/student/change-password") && method === "POST") {
      const body = await req.json();
      const nis = String(body.nisn || body.nis || "").trim();
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");

      if (!nis || !currentPassword || !newPassword) {
        return jsonResponse(
          { success: false, message: "Semua kolom wajib diisi." },
          400
        );
      }

      if (newPassword.length < 4) {
        return jsonResponse(
          { success: false, message: "Password baru minimal 4 karakter." },
          400
        );
      }

      let user = null;
      try {
        const rows = await db
          .select()
          .from(students)
          .where(eq(students.nis, nis));
        user = rows[0];
      } catch {}

      if (!user) {
        const cached = cachedStudents.find((s) => s.nis === nis);
        if (cached) user = cached;
      }

      if (!user) {
        return jsonResponse(
          { success: false, message: "Siswa tidak ditemukan." },
          404
        );
      }

      const localPasswordMap = getLocalJson("student_passwords.json", {});
      const effectivePassword = localPasswordMap[nis] || user.password;

      if (effectivePassword !== currentPassword) {
        return jsonResponse(
          { success: false, message: "Password saat ini tidak sesuai." },
          400
        );
      }

      // Update in DB
      try {
        await db
          .update(students)
          .set({ password: newPassword, updatedAt: new Date() })
          .where(eq(students.nis, nis));
      } catch {}

      // Update in fallback map
      localPasswordMap[nis] = newPassword;
      setLocalJson("student_passwords.json", localPasswordMap);

      return jsonResponse({
        success: true,
        message: "Password berhasil diperbarui.",
      });
    }

    // 3. Admin Login: POST /api/admin/login
    if (pathname.endsWith("/api/admin/login") && method === "POST") {
      const body = await req.json();
      const username = String(body.username || "").trim();
      const password = String(body.password || "").trim();

      let admin = null;
      try {
        const rows = await db
          .select()
          .from(adminSettings)
          .where(eq(adminSettings.username, username));
        if (rows.length > 0) admin = rows[0];
      } catch (err) {}

      const localAdmin = getLocalJson("admin_creds.json", {
        username: "admin",
        password: "admin123",
      });

      if (!admin && username === localAdmin.username) {
        admin = localAdmin;
      }

      if (!admin || admin.password !== password) {
        return jsonResponse(
          { success: false, message: "Username atau password salah!" },
          401
        );
      }

      return jsonResponse({
        success: true,
        admin: { username: admin.username },
      });
    }

    // 4. Admin Change Credentials: POST /api/admin/change-credentials
    if (
      pathname.endsWith("/api/admin/change-credentials") &&
      method === "POST"
    ) {
      const body = await req.json();
      const currentUsername = String(body.currentUsername || "").trim();
      const currentPassword = String(body.currentPassword || "").trim();
      const newUsername = String(body.newUsername || "").trim();
      const newPassword = String(body.newPassword || "").trim();

      const localAdmin = getLocalJson("admin_creds.json", {
        username: "admin",
        password: "admin123",
      });

      let admin = null;
      try {
        const rows = await db
          .select()
          .from(adminSettings)
          .where(eq(adminSettings.username, currentUsername));
        admin = rows[0];
      } catch {}

      if (!admin && currentUsername === localAdmin.username) {
        admin = localAdmin;
      }

      if (!admin || admin.password !== currentPassword) {
        return jsonResponse(
          {
            success: false,
            message: "Username atau password saat ini tidak sesuai.",
          },
          400
        );
      }

      if (newUsername.length < 3 || newPassword.length < 6) {
        return jsonResponse(
          {
            success: false,
            message:
              "Username minimal 3 karakter dan password minimal 6 karakter.",
          },
          400
        );
      }

      try {
        if (admin && admin.id) {
          await db
            .update(adminSettings)
            .set({ username: newUsername, password: newPassword })
            .where(eq(adminSettings.username, currentUsername));
        } else {
          await db
            .insert(adminSettings)
            .values({ username: newUsername, password: newPassword });
        }
      } catch {}

      setLocalJson("admin_creds.json", {
        username: newUsername,
        password: newPassword,
      });

      return jsonResponse({
        success: true,
        message: "Username dan password admin berhasil diperbarui.",
      });
    }

    // 5. Proker Evaluations (Evaluasi Umum)
    // GET /api/evaluations
    if (pathname.endsWith("/api/evaluations") && method === "GET") {
      let evals: any[] = [];
      try {
        const rows = await db
          .select()
          .from(prokerEvaluations)
          .orderBy(desc(prokerEvaluations.timestamp));

        evals = rows.map((r) => ({
          id: r.id,
          date: r.date,
          timestamp: r.timestamp ? r.timestamp.toISOString() : new Date().toISOString(),
          studentNis: r.studentNis,
          studentName: r.studentName,
          studentClass: r.studentClass,
          attendance: r.attendance,
          answers: {
            q1: r.q1,
            q2: r.q2,
            q3: r.q3,
            q4: r.q4,
            q5: r.q5,
          },
        }));
      } catch (err) {
        evals = getLocalJson("evaluations.json", []);
      }

      // If DB was empty or error, check fallback cache
      if (evals.length === 0) {
        evals = getLocalJson("evaluations.json", []);
      }

      return jsonResponse(evals);
    }

    // POST /api/evaluations
    if (pathname.endsWith("/api/evaluations") && method === "POST") {
      const body = await req.json();
      const id =
        body.id ||
        "PROKER-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
      const studentNis = String(body.studentNis || body.nisn || "").trim();
      const studentName = String(body.studentName || "").trim();
      const studentClass = String(body.studentClass || "").trim();
      const attendance = String(body.attendance || "-").trim();
      const date =
        body.date ||
        new Date().toLocaleDateString("id-ID", {
          timeZone: "Asia/Jakarta",
        });
      const answers = body.answers || {};

      const evalItem = {
        id,
        studentNis,
        studentName,
        studentClass,
        attendance,
        date,
        timestamp: new Date().toISOString(),
        answers: {
          q1: String(answers.q1 || body.q1 || ""),
          q2: String(answers.q2 || body.q2 || ""),
          q3: String(answers.q3 || body.q3 || ""),
          q4: String(answers.q4 || body.q4 || ""),
          q5: String(answers.q5 || body.q5 || ""),
        },
      };

      try {
        await db
          .insert(prokerEvaluations)
          .values({
            id,
            studentNis,
            studentName,
            studentClass,
            attendance,
            date,
            q1: evalItem.answers.q1,
            q2: evalItem.answers.q2,
            q3: evalItem.answers.q3,
            q4: evalItem.answers.q4,
            q5: evalItem.answers.q5,
          })
          .onConflictDoNothing();
      } catch (err) {
        console.warn("DB insert prokerEvaluations fallback:", err);
      }

      const localEvals = getLocalJson("evaluations.json", []);
      localEvals.unshift(evalItem);
      setLocalJson("evaluations.json", localEvals);

      return jsonResponse({
        success: true,
        evaluation: evalItem,
      });
    }

    // DELETE /api/evaluations/:id or DELETE /api/evaluations
    if (pathname.includes("/api/evaluations") && method === "DELETE") {
      const parts = pathname.split("/api/evaluations");
      const idParam = parts[1] ? parts[1].replace(/^\//, "") : "";
      try {
        if (idParam) {
          await db
            .delete(prokerEvaluations)
            .where(eq(prokerEvaluations.id, idParam));
        } else {
          await db.delete(prokerEvaluations);
        }
      } catch (err) {}

      const localEvals = getLocalJson("evaluations.json", []);
      if (idParam) {
        setLocalJson(
          "evaluations.json",
          localEvals.filter((x: any) => x.id !== idParam)
        );
      } else {
        setLocalJson("evaluations.json", []);
      }

      return jsonResponse({ success: true, deletedId: idParam || "all" });
    }

    // 6. Surveys (Survei Kepuasan)
    // GET /api/surveys
    if (pathname.endsWith("/api/surveys") && method === "GET") {
      let surveyList: any[] = [];
      try {
        const rows = await db
          .select()
          .from(surveys)
          .orderBy(desc(surveys.timestamp));

        surveyList = rows.map((r) => {
          let answersObj: Record<string, string> = {};
          try {
            answersObj = JSON.parse(r.answers || "{}");
          } catch {}

          return {
            id: r.id,
            department: r.department,
            departmentTitle: r.departmentTitle,
            studentNis: r.studentNis,
            studentName: r.studentName,
            studentClass: r.studentClass,
            attendance: r.attendance,
            date: r.date,
            timestamp: r.timestamp ? r.timestamp.toISOString() : new Date().toISOString(),
            answers: answersObj,
            notes: r.notes,
            toiletSatisfaction: answersObj.toiletSatisfaction || answersObj.satisfactionToilet || "-",
            classroomSatisfaction: answersObj.classroomSatisfaction || answersObj.satisfactionClassroom || "-",
          };
        });
      } catch (err) {
        surveyList = getLocalJson("surveys.json", []);
      }

      if (surveyList.length === 0) {
        surveyList = getLocalJson("surveys.json", []);
      }

      return jsonResponse(surveyList);
    }

    // POST /api/surveys
    if (pathname.endsWith("/api/surveys") && method === "POST") {
      const body = await req.json();
      const id =
        body.id || "SRV-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
      const department = String(body.department || "sarpras").trim();
      const departmentTitle = String(
        body.departmentTitle || "Sarana Prasarana"
      ).trim();
      const studentNis = String(body.studentNis || body.nisn || "").trim();
      const studentName = String(body.studentName || "").trim();
      const studentClass = String(body.studentClass || "").trim();
      const attendance = String(body.attendance || "-").trim();
      const date =
        body.date || new Date().toISOString().split("T")[0];
      const notes = String(body.notes || "-").trim();

      const answers = body.answers || {};
      if (body.toiletSatisfaction) answers.toiletSatisfaction = body.toiletSatisfaction;
      if (body.classroomSatisfaction) answers.classroomSatisfaction = body.classroomSatisfaction;

      const surveyItem = {
        id,
        department,
        departmentTitle,
        studentNis,
        studentName,
        studentClass,
        attendance,
        date,
        timestamp: new Date().toISOString(),
        answers,
        notes,
        toiletSatisfaction: answers.toiletSatisfaction || "-",
        classroomSatisfaction: answers.classroomSatisfaction || "-",
      };

      try {
        await db
          .insert(surveys)
          .values({
            id,
            department,
            departmentTitle,
            studentNis,
            studentName,
            studentClass,
            attendance,
            date,
            answers: JSON.stringify(answers),
            notes,
          })
          .onConflictDoNothing();
      } catch (err) {
        console.warn("DB insert surveys fallback:", err);
      }

      const localSurveys = getLocalJson("surveys.json", []);
      localSurveys.unshift(surveyItem);
      setLocalJson("surveys.json", localSurveys);

      return jsonResponse({
        success: true,
        survey: surveyItem,
      });
    }

    // DELETE /api/surveys/:id or DELETE /api/surveys?department=...
    if (pathname.includes("/api/surveys") && method === "DELETE") {
      const parts = pathname.split("/api/surveys");
      const idParam = parts[1] ? parts[1].replace(/^\//, "") : "";
      const deptQuery = url.searchParams.get("department");

      try {
        if (idParam) {
          await db.delete(surveys).where(eq(surveys.id, idParam));
        } else if (deptQuery) {
          await db.delete(surveys).where(eq(surveys.department, deptQuery));
        } else {
          await db.delete(surveys);
        }
      } catch (err) {}

      const localSurveys = getLocalJson("surveys.json", []);
      if (idParam) {
        setLocalJson(
          "surveys.json",
          localSurveys.filter((x: any) => x.id !== idParam)
        );
      } else if (deptQuery) {
        setLocalJson(
          "surveys.json",
          localSurveys.filter((x: any) => x.department !== deptQuery)
        );
      } else {
        setLocalJson("surveys.json", []);
      }

      return jsonResponse({ success: true, deleted: idParam || deptQuery || "all" });
    }

    // 7. GET /api/students: Search or list students
    if (pathname.endsWith("/api/students") && method === "GET") {
      const nisQuery = url.searchParams.get("nis");
      if (nisQuery) {
        const student = cachedStudents.find((s) => s.nis === nisQuery);
        if (student) {
          return jsonResponse({
            nis: student.nis,
            name: student.name,
            studentClass: student.studentClass,
            attendance: student.attendance,
            gender: student.gender,
            grade: student.grade,
          });
        }
      }
      return jsonResponse({ totalCached: cachedStudents.length });
    }

    return jsonResponse({ error: "Endpoint not found" }, 404);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Server error";
    console.error("API error:", error);
    return jsonResponse({ success: false, error: message }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
