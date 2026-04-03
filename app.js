import { Amplify } from "aws-amplify";
import {
  signIn,
  confirmSignIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
} from "aws-amplify/auth";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: "ap-south-1_OuutbLcox",
      userPoolClientId: "1ju1f0luarghoud499amanijm2",
      loginWith: { email: true },
    },
  },
});

async function requireAuth(requiredRole = null) {
  try {
    const user = await getCurrentUser();
    const session = await fetchAuthSession();
    const groups = session.tokens.idToken.payload["cognito:groups"] || [];

    if (!groups.includes("Employee") && !groups.includes("HRAdmin")) {
      showView("login");
      return null;
    }

    const isAdmin = groups.includes("HRAdmin");
    if (requiredRole === "admin" && !isAdmin) {
      alert("Unauthorized - HRAdmin group required");
      showView("login");
      return null;
    }

    return { userId: user.userId, username: user.username, groups };
  } catch {
    return null;
  }
}

async function login(email, password) {
  try {
    const { nextStep } = await signIn({ username: email, password });

    if (nextStep.signInStep === "DONE") {
      const session = await fetchAuthSession();
      const idToken = session.tokens.idToken.toString();
      const accessToken = session.tokens.accessToken.toString();

      sessionStorage.setItem("idToken", idToken);
      sessionStorage.setItem("accessToken", accessToken);

      const claims = session.tokens.idToken.payload;
      const groups = claims["cognito:groups"] || [];

      if (!groups.includes("Employee") && !groups.includes("HRAdmin")) {
        throw new Error(
          "Login failed: You must be in the 'Employee' or 'HRAdmin' Cognito group.",
        );
      }

      const isAdmin = groups.includes("HRAdmin");
      return {
        success: true,
        role: isAdmin ? "admin" : "employee",
        userId: claims.sub,
      };
    }

    if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
      return { success: false, requiresNewPassword: true };
    }
  } catch (error) {
    console.error("Cognito login error:", error);
    if (error.name === "NotAuthorizedException")
      return { success: false, message: "Incorrect email or password" };
    if (error.name === "UserNotConfirmedException")
      return { success: false, message: "Please verify your email first" };

    let errorMsg = error.message || String(error);
    return { success: false, message: errorMsg };
  }
}

async function apiCall(path, method = "GET", body = null) {
  let session;
  try {
    session = await fetchAuthSession({ forceRefresh: true });
  } catch (e) {
    showView("login");
    return null;
  }

  if (!session.tokens) {
    showView("login");
    return null;
  }

  const idToken = session.tokens.idToken.toString();
  const USERS_API_BASE_URL =
    "https://m5whfs5ivf.execute-api.ap-south-1.amazonaws.com/prod";
  const LMS_API_BASE_URL =
    "https://yxa4h8pija.execute-api.ap-south-1.amazonaws.com/backend";

  const baseUrl = path.startsWith("/users")
    ? USERS_API_BASE_URL
    : LMS_API_BASE_URL;
  const headers = { Authorization: idToken };
  if (body) headers["Content-Type"] = "application/json";

  const options = { method, headers, mode: "cors" };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${baseUrl}${path}`, options);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const resText = await res.text();
  return resText ? JSON.parse(resText) : {};
}

// Global State
let state = {
  currentUser: null,
  users: [],
  courses: [],
  assignments: [],
  employeeDashboard: null,
  activeQuiz: null,
};

// UI Elements
const UI = {
  views: {
    login: document.getElementById("login-view"),
    admin: document.getElementById("hr-admin-view"),
    employee: document.getElementById("employee-view"),
  },
  toast: document.getElementById("toast"),
  admin: {
    panels: {
      courses: document.getElementById("admin-courses"),
      assignments: document.getElementById("admin-assignments"),
      skillGap: document.getElementById("admin-skill-gap"),
    },
    nav: document.querySelectorAll("#hr-admin-view .nav-item"),
    userName: document.getElementById("hr-user-name"),
    courseTable: document.getElementById("course-table-body"),
    assignCourseSelect: document.getElementById("assign-course"),
    assignTargetSelect: document.getElementById("assign-target"),
    matrixTable: document.getElementById("skill-matrix-table"),
    matrixSummary: document.getElementById("skill-matrix-summary"),
  },
  employee: {
    panels: {
      courses: document.getElementById("emp-courses"),
      viewer: document.getElementById("emp-course-viewer"),
      quiz: document.getElementById("emp-quiz-engine"),
      certificates: document.getElementById("emp-certificates"),
    },
    nav: document.querySelectorAll("#employee-view .nav-item"),
    userName: document.getElementById("emp-user-name"),
    coursesList: document.getElementById("my-courses-list"),
    videoContainer: document.getElementById("video-container"),
    viewerTitle: document.getElementById("viewer-course-title"),
    certList: document.getElementById("certificate-list"),
    verifyResult: document.getElementById("verify-result"),
  },
  modals: {
    createCourse: document.getElementById("create-course-modal"),
  },
};

// App Init
async function initApp() {
  setupEventListeners();
  try {
    const session = await fetchAuthSession({ forceRefresh: true });
    if (!session.tokens) {
      showView("login");
      return;
    }

    const authUser = await requireAuth();
    if (!authUser) {
      showView("login");
      return;
    }

    const isAdmin = authUser.groups.includes("HRAdmin");
    const role = isAdmin ? "admin" : "employee";

    try {
      const profile = await apiCall(`/users/${authUser.userId}`);
      setupUserState(authUser, profile, role);
    } catch (e) {
      if (e.message.includes("404")) {
        setupUserState(authUser, null, role);
      } else {
        showView("login");
        return;
      }
    }

    showView(role === "admin" ? "admin" : "employee");
  } catch (e) {
    showView("login");
  }
}

function setupUserState(authUser, profile, role) {
  let user = state.users.find((u) => u.id === authUser.userId);
  if (!user) {
    user = {
      id: authUser.userId,
      employee_id: profile?.employee_id || authUser.userId,
      name: profile?.name || authUser.username || "User",
      email: authUser.username,
      role,
      department: profile?.department || "Engineering",
      asDept: profile?.department || "Engineering",
    };
    state.users.push(user);
  } else {
    user.role = role;
    user.employee_id =
      profile?.employee_id || user.employee_id || authUser.userId;
    user.department = profile?.department || user.department || "Engineering";
    user.asDept = profile?.department || user.asDept || "Engineering";
    if (profile) user.name = profile.name || user.name;
  }
  state.currentUser = user;
}

function setupEventListeners() {
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document
    .getElementById("hr-logout-btn")
    .addEventListener("click", handleLogout);
  document
    .getElementById("emp-logout-btn")
    .addEventListener("click", handleLogout);

  UI.admin.nav.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      switchPanel(UI.admin.nav, UI.admin.panels, e.target.dataset.target);
    });
  });

  UI.employee.nav.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      switchPanel(UI.employee.nav, UI.employee.panels, e.target.dataset.target);
    });
  });

  document
    .getElementById("btn-create-course")
    .addEventListener("click", openCreateCourseModal);
  document
    .querySelectorAll(".modal-close")
    .forEach((btn) => btn.addEventListener("click", closeModals));
  document
    .getElementById("btn-add-question")
    .addEventListener("click", addQuestionToBuilder);
  document
    .getElementById("create-course-form")
    .addEventListener("submit", handleCreateCourse);
  document
    .getElementById("assignment-form")
    .addEventListener("submit", handleAssignCourse);

  document
    .getElementById("btn-back-courses")
    .addEventListener("click", () =>
      switchPanel(UI.employee.nav, UI.employee.panels, "emp-courses"),
    );
  document.getElementById("btn-take-quiz").addEventListener("click", startQuiz);
  document
    .getElementById("btn-quiz-next")
    .addEventListener("click", handleNextQuestion);
  document
    .getElementById("btn-quiz-retake")
    .addEventListener("click", startQuiz);
  document
    .getElementById("btn-quiz-finish")
    .addEventListener("click", () =>
      switchPanel(UI.employee.nav, UI.employee.panels, "emp-courses"),
    );
  document
    .getElementById("btn-verify-cert")
    .addEventListener("click", verifyCertificate);
}

function showToast(message) {
  UI.toast.textContent = message;
  UI.toast.classList.remove("hidden");
  UI.toast.classList.add("show");
  setTimeout(() => {
    UI.toast.classList.remove("show");
    setTimeout(() => UI.toast.classList.add("hidden"), 300);
  }, 3000);
}

function switchPanel(navItems, panelsObj, targetId) {
  navItems.forEach((nav) => {
    if (nav.dataset.target === targetId) nav.classList.add("active");
    else nav.classList.remove("active");
  });
  Object.values(panelsObj).forEach((panel) => {
    if (panel.id === targetId) panel.classList.remove("hidden");
    else panel.classList.add("hidden");
  });
}

async function showView(viewName) {
  Object.values(UI.views).forEach((v) => v.classList.add("hidden"));
  UI.views[viewName].classList.remove("hidden");

  if (viewName === "admin") await initAdminDashboard();
  if (viewName === "employee") await initEmployeeDashboard();
}

/* ---- AUTH ---- */
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const errorDiv = document.getElementById("error-message");
  const btn = document.getElementById("login-btn");

  btn.disabled = true;
  btn.textContent = "Signing in...";
  if (errorDiv) errorDiv.textContent = "";

  const result = await login(email, password);

  if (result.success) {
    btn.textContent = "Verifying Profile Data...";
    let profile = null;
    try {
      profile = await apiCall(`/users/${result.userId}`);
    } catch (e) {
      if (e.message && e.message.includes("401")) {
        console.error("Token rejected by API.");
        showView("login");
        btn.disabled = false;
        btn.textContent = "Sign in";
        return;
      }
      // 404 or other — proceed with null profile
    }

    let user = state.users.find((u) => u.email === email);
    if (!user) {
      user = {
        id: result.userId,
        employee_id: profile?.employee_id || result.userId,
        name: profile?.name || email.split("@")[0],
        email,
        role: result.role,
        department: profile?.department || "Engineering",
        asDept: profile?.department || "Engineering",
        manager: profile?.manager || "N/A",
        joiningDate: profile?.joiningDate || "N/A",
        employmentType: profile?.employmentType || "Full-time",
      };
      state.users.push(user);
    } else {
      user.role = result.role;
      user.employee_id =
        profile?.employee_id || user.employee_id || result.userId;
      user.department = profile?.department || user.department || "Engineering";
      user.asDept = profile?.department || user.asDept || "Engineering";
      if (profile) user.name = profile.name || user.name;
    }

    state.currentUser = user;
    if (errorDiv) errorDiv.textContent = "";
    showView(result.role === "admin" ? "admin" : "employee");
    btn.disabled = false;
    btn.textContent = "Sign in";
  } else if (result.requiresNewPassword) {
    const newPassword = prompt(
      "Your administrator requires you to change your password. Enter a new password:",
    );
    if (!newPassword) {
      if (errorDiv) errorDiv.textContent = "You must enter a new password.";
      btn.disabled = false;
      btn.textContent = "Sign in";
      return;
    }
    btn.textContent = "Setting new password...";
    try {
      const confirmResult = await confirmSignIn({
        challengeResponse: newPassword,
      });
      if (confirmResult.nextStep.signInStep === "DONE") {
        alert("Password updated! Redirecting...");
        window.location.reload();
        return;
      } else {
        if (errorDiv)
          errorDiv.textContent =
            "Further action required. Check Cognito configuration.";
      }
    } catch (e) {
      if (errorDiv)
        errorDiv.textContent = e.message || "Failed to update password.";
    }
    btn.disabled = false;
    btn.textContent = "Sign in";
  } else {
    if (errorDiv) errorDiv.textContent = result.message || "Login failed.";
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

async function handleLogout() {
  try {
    await signOut();
  } catch (e) {
    console.error("Sign out error", e);
  }
  sessionStorage.removeItem("idToken");
  sessionStorage.removeItem("accessToken");
  state.currentUser = null;
  window.location.href = "/index.html";
}

/* ---- HR ADMIN ---- */
async function initAdminDashboard() {
  try {
    const res = await apiCall("/courses", "GET");
    const raw = Array.isArray(res) ? res : res.courses || [];
    state.courses = raw.map((c) => ({
      ...c,
      course_id: c.course_id || c.id || c.courseId || c.courseID,
    }));
  } catch (e) {
    console.error("Failed to fetch courses", e);
    showToast("Error loading courses");
    state.courses = [];
  }

  try {
    const uRes = await apiCall("/users", "GET");
    state.users = Array.isArray(uRes) ? uRes : uRes.users || [];
  } catch (e) {
    console.warn("Could not load users list", e);
  }

  renderCourseTable();
  populateAssignmentDropdowns();
  renderSkillGapDashboard();
}

function renderCourseTable() {
  UI.admin.courseTable.innerHTML = "";
  state.courses.forEach((course) => {
    const roleValue = course.assigned_roles ?? course.roles;
    const roleDisplay =
      typeof roleValue === "string" && roleValue.trim()
        ? roleValue.trim()
        : "All";

    const tr = document.createElement("tr");
    tr.innerHTML = `
            <td><strong>${course.title}</strong></td>
            <td>${course.description || ""}</td>
            <td><a href="${course.video_url || course.videoUrl || "#"}" target="_blank">Link</a></td>
            <td>${course.passingScore || "N/A"}%</td>
            <td>${roleDisplay}</td>
            <td><span class="badge status-blue">${course.questions ? course.questions.length : "?"} Qs</span></td>
        `;
    UI.admin.courseTable.appendChild(tr);
  });
}

function populateAssignmentDropdowns() {
  UI.admin.assignCourseSelect.innerHTML =
    '<option value="">-- Select Course --</option>';
  state.courses.forEach((c) => {
    if (!c.course_id) return;
    const opt = document.createElement("option");
    opt.value = c.course_id;
    opt.textContent = c.title;
    UI.admin.assignCourseSelect.appendChild(opt);
  });

  // Clear old options except the first placeholder
  while (UI.admin.assignTargetSelect.options.length > 1) {
    UI.admin.assignTargetSelect.remove(1);
  }

  const empGroup = document.createElement("optgroup");
  empGroup.label = "Specific Employees";
  state.users
    .filter((u) => u.role === "employee" || u.role === "Employee")
    .forEach((u) => {
      const employeeId = u.employee_id || u.id;
      const opt = document.createElement("option");
      opt.value = `user:${employeeId}`;
      opt.textContent = `${u.name} (${u.asDept || u.department || "N/A"})`;
      empGroup.appendChild(opt);
    });
  UI.admin.assignTargetSelect.appendChild(empGroup);
}

async function handleAssignCourse(e) {
  e.preventDefault();
  const courseId = UI.admin.assignCourseSelect.value;
  const target = UI.admin.assignTargetSelect.value;
  const dueDate = document.getElementById("assign-due-date").value;

  if (!courseId || courseId === "undefined") {
    showToast("Please select a valid course.");
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Assigning...";

  try {
    const res = await apiCall(`/courses/${courseId}/assign`, "POST", {
      target,
      due_date: dueDate,
    });
    showToast(res?.message || "Course assigned successfully.");
    e.target.reset();
    await initAdminDashboard();
  } catch (err) {
    showToast(`Assignment failed: ${err.message}`);
    console.error(err);
  }

  btn.disabled = false;
  btn.textContent = originalText;
}

function openCreateCourseModal() {
  document.getElementById("create-course-form").reset();
  document.getElementById("quiz-builder-questions").innerHTML = "";
  builderQCount = 0;
  addQuestionToBuilder();
  UI.modals.createCourse.classList.remove("hidden");
}

function closeModals() {
  UI.modals.createCourse.classList.add("hidden");
}

let builderQCount = 0;
function addQuestionToBuilder() {
  builderQCount++;
  const container = document.getElementById("quiz-builder-questions");
  const qDiv = document.createElement("div");
  qDiv.className = "question-builder-item form-grid";
  qDiv.id = `builder-q-${builderQCount}`;

  qDiv.innerHTML = `
        <div class="input-group" style="grid-column: 1 / -1;">
            <label>Question ${builderQCount} Text</label>
            <input type="text" class="q-text" required placeholder="e.g. What is AWS?">
        </div>
        <div class="input-group">
            <label>Option A (Correct Answer)</label>
            <input type="text" class="q-opt-a" required>
        </div>
        <div class="input-group">
            <label>Option B</label>
            <input type="text" class="q-opt-b" required>
        </div>
        <div class="input-group">
            <label>Option C</label>
            <input type="text" class="q-opt-c" required>
        </div>
        <div class="input-group">
            <label>Option D</label>
            <input type="text" class="q-opt-d" required>
        </div>
        <button type="button" class="btn btn-logout btn-small" onclick="document.getElementById('${qDiv.id}').remove()">Remove</button>
    `;
  container.appendChild(qDiv);
}

async function handleCreateCourse(e) {
  e.preventDefault();
  const title = document.getElementById("new-course-title").value;
  const desc = document.getElementById("new-course-desc").value;
  const url = document.getElementById("new-course-url").value;
  const score = parseInt(document.getElementById("new-course-score").value);
  const roles = document.getElementById("new-course-roles").value.trim();

  const btn = e.target.querySelector('button[type="submit"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving...";

  const questions = [];
  document.querySelectorAll(".question-builder-item").forEach((item) => {
    const text = item.querySelector(".q-text").value;
    const optA = item.querySelector(".q-opt-a").value;
    const optB = item.querySelector(".q-opt-b").value;
    const optC = item.querySelector(".q-opt-c").value;
    const optD = item.querySelector(".q-opt-d").value;
    questions.push({
      text,
      options: [optA, optB, optC, optD].filter(Boolean),
      correct_answer: optA,
    });
  });

  try {
    const courseId = "c-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    await apiCall("/courses", "POST", {
      course_id: courseId,
      title,
      description: desc,
      video_url: url,
      passingScore: score,
      assigned_roles: roles,
      questions,
    });
    showToast(`Course "${title}" created successfully.`);
    closeModals();
    await initAdminDashboard();
  } catch (err) {
    showToast(`Failed to create course: ${err.message}`);
    console.error(err);
  }

  btn.disabled = false;
  btn.textContent = originalText;
}

function renderSkillGapDashboard() {
  const employees = state.users.filter(
    (u) => u.role === "employee" || u.role === "Employee",
  );
  const courses = state.courses;

  let tableHTML = "<thead><tr><th>Employee</th>";
  courses.forEach((c) => (tableHTML += `<th>${c.title}</th>`));
  tableHTML += "</tr></thead><tbody>";

  const today = new Date().toISOString().split("T")[0];

  employees.forEach((emp) => {
    tableHTML += `<tr><th>${emp.name}<br><small style="color:var(--text-muted);font-weight:normal">${emp.asDept || emp.department || "N/A"}</small></th>`;
    courses.forEach((course) => {
      const assignment = state.assignments.find(
        (a) => a.userId === emp.id && a.courseId === course.course_id,
      );
      if (!assignment) {
        tableHTML += `<td class="cell-bg-not-started">N/A</td>`;
      } else {
        let cellClass = "cell-bg-not-started";
        if (assignment.status === "passed") cellClass = "cell-bg-passed";
        else if (assignment.status === "failed") cellClass = "cell-bg-failed";
        else if (assignment.status === "in_progress")
          cellClass = "cell-bg-in-progress";

        const isOverdue =
          assignment.status !== "passed" &&
          assignment.dueDate &&
          assignment.dueDate < today;

        tableHTML += `<td class="${cellClass} ${isOverdue ? "overdue-cell" : ""}">
                    ${assignment.status}
                    ${isOverdue ? '<span class="overdue-badge">OVERDUE</span>' : ""}
                </td>`;
      }
    });
    tableHTML += "</tr>";
  });
  tableHTML += "</tbody>";
  UI.admin.matrixTable.innerHTML = tableHTML;

  const depts = {};
  employees.forEach((e) => {
    const d = e.asDept || e.department || "Unknown";
    if (!depts[d]) depts[d] = { total: 0, passed: 0 };
  });

  state.assignments.forEach((a) => {
    const emp = employees.find((e) => e.id === a.userId);
    if (emp) {
      const d = emp.asDept || emp.department || "Unknown";
      if (depts[d]) {
        depts[d].total++;
        if (a.status === "passed") depts[d].passed++;
      }
    }
  });

  UI.admin.matrixSummary.innerHTML = "";
  Object.keys(depts).forEach((dept) => {
    const d = depts[dept];
    const pct = d.total === 0 ? 0 : Math.round((d.passed / d.total) * 100);

    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
            <div class="bar-label">${dept}</div>
            <div class="bar-track">
                <div class="bar-fill" style="width: 0%"></div>
                <div class="bar-value">${pct}%</div>
            </div>
        `;
    UI.admin.matrixSummary.appendChild(row);
    setTimeout(
      () => (row.querySelector(".bar-fill").style.width = pct + "%"),
      100,
    );
  });
}

/* ---- EMPLOYEE DASHBOARD ---- */
async function initEmployeeDashboard() {
<<<<<<< HEAD
    try {
        // ✅ Use employee_id first, fall back to id
        const employeeId = state.currentUser.employee_id || state.currentUser.id;
        const dash = await apiCall(`/employees/${employeeId}/dashboard`, 'GET');
        state.employeeDashboard = dash;
        state.courses = Array.isArray(dash?.courses) ? dash.courses : [];
    } catch(e) {
        console.error("Failed to load employee courses", e);
        state.employeeDashboard = null;
        state.courses = [];
=======
  try {
    const dash = await apiCall(
      `/employees/${state.currentUser.id}/dashboard`,
      "GET",
    );
    state.employeeDashboard = dash;
    state.courses = Array.isArray(dash?.courses) ? dash.courses : [];

    // Update display name from dashboard data
    if (dash?.employee?.name && UI.employee.userName) {
      UI.employee.userName.textContent = dash.employee.name;
>>>>>>> 21b1fdcaa86c8e14f4ae997856864118e089e8d8
    }
  } catch (e) {
    console.error("Failed to load employee dashboard", e);
    state.employeeDashboard = null;
    state.courses = [];
  }

  renderMyCourses();
  renderCertificates();
  switchPanel(UI.employee.nav, UI.employee.panels, "emp-courses");
}

function getVideoEmbedUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const urlString = rawUrl.trim();
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    if (hostname.includes("youtube.com")) {
      if (pathname.startsWith("/embed/")) return urlString;
      if (pathname.startsWith("/watch")) {
        const videoId = parsed.searchParams.get("v");
        if (videoId) return `https://www.youtube.com/embed/${videoId}`;
      }
      if (pathname.startsWith("/shorts/")) {
        const videoId = pathname.split("/shorts/")[1];
        if (videoId) return `https://www.youtube.com/embed/${videoId}`;
      }
    }

    if (hostname.includes("youtu.be")) {
      const videoId = pathname.slice(1).split("?")[0];
      if (videoId) return `https://www.youtube.com/embed/${videoId}`;
    }

    if (hostname.includes("vimeo.com")) {
      const videoId = pathname.split("/").filter(Boolean).pop();
      if (videoId && /^\d+$/.test(videoId))
        return `https://player.vimeo.com/video/${videoId}`;
    }
  } catch (err) {
    return null;
  }
  return null;
}

function renderMyCourses() {
  UI.employee.coursesList.innerHTML = "";
  const myCourses = state.courses || [];
  if (myCourses.length === 0) {
    UI.employee.coursesList.innerHTML = "<p>No courses assigned.</p>";
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  myCourses.forEach((course) => {
    const statusRaw = (course.status || "")
      .toString()
      .toLowerCase()
      .replace(/[\s-]/g, "_");
    const statusLabel =
      statusRaw === "passed"
        ? "Passed"
        : statusRaw === "failed"
          ? "Failed"
          : statusRaw === "in_progress"
            ? "In Progress"
            : "Not Started";

    let statusClass = "status-grey";
    if (statusLabel === "Passed") statusClass = "status-green";
    else if (statusLabel === "Failed") statusClass = "status-red";
    else if (statusLabel === "In Progress") statusClass = "status-blue";

    const dueDate = course.due_date || course.dueDate || null;
    const attempts = course.attempts ?? course.attempt_count ?? 0;
    const isOverdue = statusLabel !== "Passed" && dueDate && dueDate < today;

    const card = document.createElement("div");
    card.className = "course-card";
    card.innerHTML = `
            <h3>${course.title}</h3>
            <p>${course.description || ""}</p>
            <div class="course-meta">
                <span class="badge ${statusClass}">${statusLabel}</span>
                <span class="due-date ${isOverdue ? "overdue" : ""}">Due: ${dueDate || "N/A"}</span>
            </div>
            ${
              statusLabel === "Passed"
                ? `<a href="${course.s3_link || "#"}" target="_blank" class="btn btn-success">Download Certificate</a>`
                : attempts >= 3
                  ? `<button class="btn btn-secondary" disabled>Max Attempts Reached</button>`
                  : `<button class="btn btn-primary btn-view-course" data-course-id="${course.course_id}">Go to Course</button>`
            }
        `;
    UI.employee.coursesList.appendChild(card);
  });

  document.querySelectorAll(".btn-view-course").forEach((btn) => {
    btn.addEventListener("click", (e) =>
      openCourseViewer(e.target.dataset.courseId),
    );
  });
}

function openCourseViewer(courseId) {
  const course = (state.courses || []).find((c) => c.course_id === courseId);
  if (!course) return;

  const embedUrl = getVideoEmbedUrl(course.video_url || course.videoUrl || "");

  UI.employee.viewerTitle.textContent = course.title;
  if (embedUrl) {
    UI.employee.videoContainer.innerHTML = `<iframe src="${embedUrl}" frameborder="0" allowfullscreen></iframe>`;
  } else if (course.video_url || course.videoUrl) {
    UI.employee.videoContainer.innerHTML = `
            <p>This video cannot be embedded. <a href="${course.video_url || course.videoUrl}" target="_blank" rel="noopener">Open in new tab</a></p>
        `;
  } else {
    UI.employee.videoContainer.innerHTML = `<p>No video URL provided for this course.</p>`;
  }

  state.activeQuiz = {
    course,
    currentQuestionIndex: 0,
    score: 0,
    shuffledQuestions: [],
    userAnswers: [],
  };

  switchPanel(UI.employee.nav, UI.employee.panels, "emp-course-viewer");
}

/* ---- QUIZ ENGINE ---- */
async function startQuiz() {
  if (!state.activeQuiz) return;

  document.getElementById("quiz-result-container").classList.add("hidden");
  document.getElementById("quiz-question-container").classList.remove("hidden");

  const btnNext = document.getElementById("btn-quiz-next");
  btnNext.classList.remove("hidden");
  btnNext.textContent = "Loading Questions...";
  btnNext.disabled = true;

  try {
    // Uses course_id (consistent with new index.mjs)
    const res = await apiCall(
      `/courses/${state.activeQuiz.course.course_id}/quiz`,
      "GET",
    );
    const questions = Array.isArray(res) ? res : res.questions || [];

    if (questions.length === 0) {
      showToast("No questions found for this quiz.");
      btnNext.disabled = false;
      return;
    }

    // Shuffle options; use question_text as fallback display if text is missing
    state.activeQuiz.shuffledQuestions = questions.map((q) => ({
      ...q,
      // Normalise the display text field — backend returns question_text, not text
      text: q.question_text || q.text || "No question text",
      shuffledOptions: [...(q.options || [])].sort(() => Math.random() - 0.5),
    }));
  } catch (err) {
    showToast("Failed to fetch quiz questions.");
    console.error(err);
    btnNext.disabled = false;
    btnNext.textContent = "Next Question";
    return;
  }

  state.activeQuiz.currentQuestionIndex = 0;
  state.activeQuiz.score = 0;
  state.activeQuiz.userAnswers = [];

  btnNext.disabled = false;
  const quizTitle = UI.employee.panels.quiz.querySelector("#quiz-course-title");
  if (quizTitle)
    quizTitle.textContent = `Quiz: ${state.activeQuiz.course.title}`;

  switchPanel(UI.employee.nav, UI.employee.panels, "emp-quiz-engine");
  renderQuestion();
}

function renderQuestion() {
  const idx = state.activeQuiz.currentQuestionIndex;
  const qObj = state.activeQuiz.shuffledQuestions[idx];
  const total = state.activeQuiz.shuffledQuestions.length;

  document.getElementById("quiz-progress-fill").style.width =
    `${(idx / total) * 100}%`;
  document.getElementById("quiz-question-text").textContent =
    `Q${idx + 1}: ${qObj.text}`;

  const optsContainer = document.getElementById("quiz-options-group");
  optsContainer.innerHTML = "";

  qObj.shuffledOptions.forEach((opt, i) => {
    // DynamoDB stores options as objects { S: "value" } — unwrap if needed
    const optValue = typeof opt === "object" && opt.S ? opt.S : String(opt);

    const div = document.createElement("div");
    div.className = "quiz-option";
    div.innerHTML = `
            <input type="radio" name="quiz-opt" id="opt-${i}" value="${optValue}">
            <label style="flex:1; cursor:pointer;" for="opt-${i}">${optValue}</label>
        `;
    div.addEventListener("click", () => {
      document
        .querySelectorAll(".quiz-option")
        .forEach((el) => el.classList.remove("selected"));
      div.classList.add("selected");
      div.querySelector("input").checked = true;
    });
    optsContainer.appendChild(div);
  });

  const btnNext = document.getElementById("btn-quiz-next");
  btnNext.textContent = idx === total - 1 ? "Submit Answers" : "Next Question";
}

async function handleNextQuestion() {
  const selected = document.querySelector('input[name="quiz-opt"]:checked');
  if (!selected) {
    showToast("Please select an answer.");
    return;
  }

  const currentQ =
    state.activeQuiz.shuffledQuestions[state.activeQuiz.currentQuestionIndex];

  // Use question_id consistently (matches DynamoDB sort key and new index.mjs grading logic)
  state.activeQuiz.userAnswers.push({
    question_id: currentQ.question_id,
    answer: selected.value,
  });

  state.activeQuiz.currentQuestionIndex++;

  if (
    state.activeQuiz.currentQuestionIndex >=
    state.activeQuiz.shuffledQuestions.length
  ) {
    await finishQuiz();
  } else {
    renderQuestion();
  }
}

async function finishQuiz() {
  document.getElementById("quiz-progress-fill").style.width = "100%";

  const btnNext = document.getElementById("btn-quiz-next");
  btnNext.disabled = true;
  btnNext.textContent = "Submitting...";

  let passed = false;
  let score = 0;
  let attempts = 0;
  let cert_id = null;
  let resultMessage = "";

  try {
    // ✅ FIX 1: Use course_id (not course.id) — matches index.mjs pathParameters
    // ✅ FIX 2: Send employee_id — required by index.mjs body destructuring
    // ✅ FIX 3: Send question_id (snake_case) — matches DynamoDB schema and grading loop
    const res = await apiCall(
      `/courses/${state.activeQuiz.course.course_id}/quiz/submit`,
      "POST",
      {
        employee_id: state.currentUser.employee_id || state.currentUser.id,
        answers: state.activeQuiz.userAnswers.map((a) => ({
          question_id: a.question_id,
          answer: a.answer,
        })),
      },
    );

    // ✅ FIX 4: Backend returns res.status ("passed"/"failed"), not res.passed (boolean)
    passed = res.status === "passed";
    score = res.score || 0;
    attempts = res.attempts ?? 0;
    cert_id = res.cert_id || null;
    resultMessage = res.message || "";
  } catch (err) {
    showToast(`Failed to submit: ${err.message}`);
    console.error(err);
    btnNext.disabled = false;
    btnNext.textContent = "Submit Answers";
    return;
  }

  document.getElementById("quiz-question-container").classList.add("hidden");
  btnNext.classList.add("hidden");
  btnNext.disabled = false;

  const resContainer = document.getElementById("quiz-result-container");
  resContainer.classList.remove("hidden");

  const titleEl = document.getElementById("quiz-result-title");
  titleEl.textContent = passed
    ? "Congratulations! You Passed."
    : "Quiz Failed.";
  titleEl.style.color = passed ? "var(--status-green)" : "var(--status-red)";

  document.getElementById("quiz-result-score").innerHTML =
    `Score: <strong>${score}%</strong> (Required: ${state.activeQuiz.course.passingScore || "?"}%)`;

  if (passed) {
    document.getElementById("btn-quiz-retake").classList.add("hidden");
    document.getElementById("quiz-result-attempts").innerHTML = cert_id
      ? `Certificate ID: <strong>${cert_id}</strong>`
      : `Attempts: ${attempts} / 3`;
    showToast("Passed! Certificate is being generated.");
  } else {
    document.getElementById("btn-quiz-retake").classList.remove("hidden");
    document.getElementById("quiz-result-attempts").innerHTML =
      `Attempts: ${attempts} / 3`;
    showToast(resultMessage || "You failed. Please try again.");
  }

  // Refresh dashboard so course card status updates
  await initEmployeeDashboard();
}

/* ---- CERTIFICATES ---- */
function renderCertificates() {
<<<<<<< HEAD
    UI.employee.certList.innerHTML = '';
    // ✅ removed && c.s3_link — show cert even without PDF link
    const earned = (state.courses || []).filter(c => c.cert_id);
    if (earned.length === 0) {
        UI.employee.certList.innerHTML = '<p>No certificates earned yet.</p>';
        return;
    }
=======
  UI.employee.certList.innerHTML = "";
  const earned = (state.courses || []).filter((c) => c.cert_id && c.s3_link);
  if (earned.length === 0) {
    UI.employee.certList.innerHTML =
      "<p>No certificates earned yet. Pass a quiz to see them here!</p>";
    return;
  }
>>>>>>> 21b1fdcaa86c8e14f4ae997856864118e089e8d8

  earned.forEach((course) => {
    const card = document.createElement("div");
    card.className = "cert-card";
    card.innerHTML = `
            <div class="cert-icon">🏆</div>
            <h3>${course.title}</h3>
            <p>ID: <strong>${course.cert_id}</strong></p>
<<<<<<< HEAD
            <p class="text-muted">${course.due_date || ''}</p>
            ${course.s3_link
                ? `<a href="${course.s3_link}" target="_blank" class="btn btn-primary mt-2">Download PDF</a>`
                : `<p class="text-muted">Certificate ID: ${course.cert_id}</p>`
            }
=======
            <p class="text-muted">${course.due_date || ""}</p>
            <a href="${course.s3_link}" target="_blank" class="btn btn-primary mt-2">Download PDF</a>
>>>>>>> 21b1fdcaa86c8e14f4ae997856864118e089e8d8
        `;
    UI.employee.certList.appendChild(card);
  });
}

function verifyCertificate(e) {
  e.preventDefault();
  const id = document.getElementById("verify-cert-id").value.trim();
  const resultDiv = document.getElementById("verify-result");
  resultDiv.classList.remove("hidden");
  resultDiv.style.marginTop = "1rem";
  resultDiv.style.padding = "1rem";
  resultDiv.style.borderRadius = "0.375rem";

  apiCall(`/verify/${id}`, "GET")
    .then((res) => {
      if (res?.valid) {
        const d = res.certificate_details || {};
        resultDiv.style.backgroundColor = "var(--status-green-bg)";
        resultDiv.style.color = "var(--status-green)";
        resultDiv.innerHTML = `<strong>Valid Certificate</strong><br>Issued to: ${d.issued_to}<br>Course: ${d.course_name}<br>Date: ${d.date_of_issue}`;
      } else {
        resultDiv.style.backgroundColor = "var(--status-red-bg)";
        resultDiv.style.color = "var(--status-red)";
        resultDiv.innerHTML = `<strong>Invalid Certificate</strong><br>${res?.message || `No record found for ID: ${id}`}`;
      }
    })
    .catch((err) => {
      resultDiv.style.backgroundColor = "var(--status-red-bg)";
      resultDiv.style.color = "var(--status-red)";
      resultDiv.innerHTML = `<strong>Verification failed</strong><br>${err.message}`;
    });
}

// Bootstrap
window.addEventListener("DOMContentLoaded", initApp);
