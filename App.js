// web/src/App.js
// Main React frontend for the Smart Student Budgeting App
// This file controls the user interface and user flow:
// 1. login
// 2. upload and scan receipt
// 3. review and correct extracted data
// 4. save receipt to history
// 5. show weekly spending, charts and item breakdown
// 6. request personalised AI advice from the Flask backend
import React, { useEffect, useState } from "react";
import "./App.css";

import { Line, Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";

// Register Chart.js components once so line and bar charts can be used in the app
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
);

// Main app component
// Uses React state to manage login, OCR results, saved history, charts and advice
export default function App() {
  // DEMO LOGIN
  // Simple demo login for MVP purposes
  // This is not full real authentication yet
  const [loggedIn, setLoggedIn] = useState(
    localStorage.getItem("loggedIn") === "true"
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  // Help panel visibility
  // Controls whether the "How to Use" help panel is visible
  const [showHelp, setShowHelp] = useState(false);

  // Checks demo username/password and unlocks the app
  function handleLogin(e) {
    e.preventDefault();
    if (username === "student" && password === "budget123") {
      localStorage.setItem("loggedIn", "true");
      setLoggedIn(true);
      setLoginError("");
    } else {
      setLoginError("Invalid credentials");
    }
  }

  // Clears login state and returns the user to the login screen
  function handleLogout() {
    localStorage.removeItem("loggedIn");
    setLoggedIn(false);
    setUsername("");
    setPassword("");
    setLoginError("");
  }

  // Upload and OCR states
  // file = selected image
  // result = OCR response from backend
  // error = any upload / validation problem shown to the user
  const [file, setFile] = useState(null);
  const [loadingOcr, setLoadingOcr] = useState(false);
  const [loadingSave, setLoadingSave] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  // These fields are filled from OCR first, but the user can edit them before saving
  // Merchant, Date and total is required because spending analysis depends on correct time data, spending place and total spend
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState("");
  const [total, setTotal] = useState("");

  // Saved receipt history loaded from SQLite through the Flask backend
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState("");

  // Advice section state
  // Can show either OpenAI advice or fallback advice from the backend
  const [advice, setAdvice] = useState([]);
  const [adviceSource, setAdviceSource] = useState("");
  const [adviceError, setAdviceError] = useState("");
  const [loadingAdvice, setLoadingAdvice] = useState(false);

  // Chart summary data returned by the backend
  // Used for daily spending trend and top merchants chart
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [loadingSummary, setLoadingSummary] = useState(false);

  // User preferences used for more personalised advice
  // weeklyBudget = spending target
  // lifestyleGoal = type of lifestyle the student wants to maintain
  const [weeklyBudget, setWeeklyBudget] = useState("");
  const [lifestyleGoal, setLifestyleGoal] = useState("Healthy");

  // Weekly tracker shows how much the user has spent so far this week
  // This helps compare real spending against the chosen weekly budget
  const [weeklySpent, setWeeklySpent] = useState(null);
  const [loadingWeekly, setLoadingWeekly] = useState(false);

  // Weekly tracker shows how much the user has spent so far this week
  // This helps compare real spending against the chosen weekly budget
  const [itemSubtotals, setItemSubtotals] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Item-level spending breakdown
  // This is loaded from the backend after GPT extracts products from receipt OCR text
  async function loadItemSubtotals() {
    setLoadingItems(true);
    try {
      const res = await fetch("http://127.0.0.1:5000/api/items/subtotals?days=30");
      const data = await res.json();
      if (res.ok) setItemSubtotals(Array.isArray(data) ? data : []);
    } catch {
      setItemSubtotals([]);
    } finally {
      setLoadingItems(false);
    }
  }

  // Loads saved receipts from SQLite for the History table
  async function loadHistory() {
    setHistoryError("");
    try {
      const res = await fetch("http://127.0.0.1:5000/api/receipts");
      const data = await res.json();
      if (!res.ok) {
        setHistoryError(data.error || "Failed to load history");
        return;
      }
      setHistory(data);
    } catch {
      setHistoryError("Could not reach backend for history.");
    }
  }

  // Loads summary data for charts
  // days parameter controls how much recent data to include
  async function loadSummary(days = 30) {
    setSummaryError("");
    setLoadingSummary(true);
    try {
      const res = await fetch(`http://127.0.0.1:5000/api/summary?days=${days}`);
      const data = await res.json();
      if (!res.ok) {
        setSummaryError(data.error || "Failed to load chart summary");
        setSummary(null);
        return;
      }
      setSummary(data);
    } catch {
      setSummaryError("Could not reach backend for chart data.");
      setSummary(null);
    } finally {
      setLoadingSummary(false);
    }
  }

  // Requests personalised advice from the backend
  // Sends weekly budget and lifestyle goal as extra context
  async function loadAdvice() {
    setAdviceError("");
    setLoadingAdvice(true);
    // Budget and goal are passed as query parameters so the backend can use them in advice generation
    try {
      const url =
        `http://127.0.0.1:5000/api/advice` +
        `?budget=${encodeURIComponent(weeklyBudget || "")}` +
        `&goal=${encodeURIComponent(lifestyleGoal || "")}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        setAdviceError(data.error || "Failed to load advice");
        setAdvice([]);
        setAdviceSource("");
        return;
      }
      setAdvice(Array.isArray(data.advice) ? data.advice : []);
      setAdviceSource(data.source || "");
    } catch {
      setAdviceError("Could not reach backend for advice.");
      setAdvice([]);
      setAdviceSource("");
    } finally {
      setLoadingAdvice(false);
    }
  }

  // Calculates how much has been spent in the current week
  // Uses saved receipt dates instead of only created_at timestamps
  async function loadWeeklySpent() {
    setLoadingWeekly(true);
    try {
      const res = await fetch("http://127.0.0.1:5000/api/receipts");
      const data = await res.json();
      if (!res.ok) return;

      // Get Monday of current week as a plain YYYY-MM-DD string (avoids UTC vs local issues)
      // This will help to compare receipts from this week only
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sun,1=Mon,...
      const diffToMonday = (dayOfWeek + 6) % 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() - diffToMonday);

      // Format monday as YYYY-MM-DD in LOCAL time (not UTC)
      const mondayStr = [
        monday.getFullYear(),
        String(monday.getMonth() + 1).padStart(2, "0"),
        String(monday.getDate()).padStart(2, "0"),
      ].join("-");

      // Today as YYYY-MM-DD string in local time
      const todayStr = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      ].join("-");

      const thisWeek = data.filter((r) => {
        // Use the receipt's date field if available, otherwise fall back to created_at date
        const receiptDay = r.date
          ? r.date.substring(0, 10)                  // "2026-03-05"
          : r.created_at.substring(0, 10);            // "2026-03-05T..."

        // Compare plain YYYY-MM-DD strings to avoid timezone problems
        return receiptDay >= mondayStr && receiptDay <= todayStr;
      });

      const total = thisWeek.reduce((sum, r) => sum + (parseFloat(r.total) || 0), 0);
      setWeeklySpent(total);
    } catch {
      setWeeklySpent(null);
    } finally {
      setLoadingWeekly(false);
    }
  }

  // Compare plain YYYY-MM-DD strings to avoid timezone problems
  useEffect(() => {
    loadHistory();
    loadAdvice();
    loadSummary(30);
    loadWeeklySpent();
    loadItemSubtotals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sends the selected receipt image to the Flask OCR endpoint
  // The backend returns raw text plus guessed merchant, date and total
  async function handleUpload(e) {
    e.preventDefault();
    setError("");
    setResult(null);

    if (!file) {
      setError("Please choose a JPG/PNG receipt first.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    try {
      setLoadingOcr(true);
      const res = await fetch("http://127.0.0.1:5000/api/ocr", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Upload failed");
        return;
      }
      // Pre-fill the form with OCR guesses so the user can check and correct them
      setResult(data);
      setMerchant(data.merchant_guess || "");
      setDate(data.date_guess || "");
      setTotal(data.total_guess ?? "");
    } catch {
      setError("Could not reach the backend. Is Flask running on 127.0.0.1:5000?");
    } finally {
      setLoadingOcr(false);
    }
  }
  // Saves the reviewed receipt into the backend database
  // Also triggers item extraction on the server side after save
  async function handleSave() {
    setError("");

    if (!merchant.trim()) {
      setError("Merchant name is required before saving.");
      return;
    }
    if (!date.trim()) {
      setError("Date is required before saving. Please enter the receipt date.");
      return;
    }
    // Basic frontend validation before sending data to the backend
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date.trim())) {
      setError("Date must be in YYYY-MM-DD format (e.g. 2026-03-05).");
      return;
    }
    if (total === "" || total === null) {
      setError("Total is required before saving.");
      return;
    }

    try {
      setLoadingSave(true);
      const formData = new FormData();
      formData.append("merchant", merchant);
      formData.append("date", date);
      formData.append("total", total);
      formData.append("raw_text", result?.raw_text || "");

      const res = await fetch("http://127.0.0.1:5000/api/receipts", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Save failed");
        return;
      }

      // Refresh all related UI sections after saving:
      /// history, advice, charts, weekly tracker and item breakdown
      await loadHistory();
      await loadAdvice();
      await loadSummary(30);
      await loadWeeklySpent();
      await loadItemSubtotals();

      // Reset form after saving
      setFile(null);
      setResult(null);
      setMerchant("");
      setDate("");
      setTotal("");
    } catch {
      setError("Could not reach backend to save.");
    } finally {
      setLoadingSave(false);
    }
  }

  // Deletes a saved receipt from history
  // Then refreshes all sections that depend on saved data
  async function handleDelete(id) {
    setHistoryError("");
    try {
      const res = await fetch(`http://127.0.0.1:5000/api/receipts/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        setHistoryError(data.error || "Delete failed");
        return;
      }
      await loadHistory();
      await loadAdvice();
      await loadSummary(30);
      await loadWeeklySpent();
      await loadItemSubtotals();
    } catch {
      setHistoryError("Could not reach backend to delete.");
    }
  }

  // Deletes a saved receipt from history
  // Then refreshes all sections that depend on saved data
  const weeklyBudgetNum = parseFloat(weeklyBudget) || 0;
  const weeklyRemaining = weeklyBudgetNum > 0 && weeklySpent !== null
    ? weeklyBudgetNum - weeklySpent
    : null;
  const weeklyOverBudget = weeklyRemaining !== null && weeklyRemaining < 0;

  // Show login page first until demo credentials are entered
  if (!loggedIn) {
    return (
      <div style={{ maxWidth: 420, margin: "100px auto", fontFamily: "Arial" }}>
        <h2>Login</h2>
        <form onSubmit={handleLogin}>
          <input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{ width: "100%", marginBottom: 10, padding: 10 }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", marginBottom: 10, padding: 10 }}
          />
          <button className="btn btnPrimary" style={{ width: "100%", padding: 10 }} type="submit">
            Login
          </button>
          {loginError && <p style={{ color: "crimson" }}>{loginError}</p>}
          <p style={{ fontSize: 12, marginTop: 12 }}>
            Demo login: <b>student</b> / <b>budget123</b>
          </p>
        </form>
      </div>
    );
  }

  // Show login page first until demo credentials are entered
  return (
    <div className="container">
      {/* Top Bar */}
      <div className="topbar">
        <div className="brand">
          <h1>Smart Student Budgeting</h1>
          <p>Receipt OCR • Spending Analysis • AI Advice</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn" onClick={() => setShowHelp(!showHelp)}>
            {showHelp ? "✕ Close Help" : "? How to Use"}
          </button>
          <button className="btn btnDanger" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      // Help panel explains how to use the app and why certain fields are required
      {/* ── HELP PANEL ── */}
      {showHelp && (
        <div className="card" style={{ borderColor: "rgba(124,92,255,0.4)", marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>📖 How to Use This App</h2>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 8 }}>
            <div>
              <h3 style={{ marginTop: 0, color: "#20e3b2" }}>Step-by-Step Guide</h3>
              <ol style={{ paddingLeft: 18, lineHeight: 1.8, margin: 0 }}>
                <li><b>Upload a Receipt</b> — take a photo or scan your paper receipt (JPG/PNG).</li>
                <li><b>Review &amp; Edit</b> — check the auto-detected merchant, date and total. Correct anything that looks wrong.</li>
                <li><b>Save to History</b> — once you're happy, save it. The image is deleted immediately for your privacy.</li>
                <li><b>Set Your Budget</b> — enter a weekly spending target and your lifestyle goal.</li>
                <li><b>Get Advice</b> — click "Get Advice" for personalised tips based on your receipts.</li>
                <li><b>Check Your Charts</b> — see how your spending trends over time and which merchants you visit most.</li>
              </ol>
            </div>

            <div>
              <h3 style={{ marginTop: 0, color: "#20e3b2" }}>Why We Ask for Each Field</h3>
              <ul style={{ paddingLeft: 18, lineHeight: 1.8, margin: 0 }}>
                <li><b>Merchant</b> — identifies where you shop so we can spot habits (e.g. frequent coffee runs).</li>
                <li><b>Date (required)</b> — lets us group spending by week/month so you can track trends over time. Without a date, we can't accurately show how much you've spent this week.</li>
                <li><b>Total</b> — the amount you spent at this shop, used to calculate your weekly budget usage.</li>
                <li><b>OCR text</b> — the raw text from your receipt is sent to AI so it can give specific advice on the items you bought, not just the total.</li>
              </ul>
            </div>

            <div>
              <h3 style={{ marginTop: 0, color: "#20e3b2" }}>Privacy &amp; Data</h3>
              <ul style={{ paddingLeft: 18, lineHeight: 1.8, margin: 0 }}>
                <li>Receipt <b>images are deleted immediately</b> after scanning — never stored.</li>
                <li>Only merchant name, date, total and OCR text are saved.</li>
                <li>Your data stays on your local server — nothing is sent externally except anonymised summaries to the AI advice feature.</li>
                <li>You can delete any receipt at any time from your History.</li>
                <li>AI advice is suggestive only — always use your own judgement for financial decisions.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      // Weekly spending overview so the user can immediately see
      // how much they have spent and how much budget remains
      {/* ── WEEKLY SPENDING TRACKER ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>📊 This Week's Spending</h2>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{
            padding: "12px 20px",
            borderRadius: 14,
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.12)",
            minWidth: 140,
            textAlign: "center"
          }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 4 }}>SPENT THIS WEEK</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#20e3b2" }}>
              {weeklySpent !== null ? `£${weeklySpent.toFixed(2)}` : "—"}
            </div>
          </div>

          {weeklyBudgetNum > 0 && (
            <div style={{
              padding: "12px 20px",
              borderRadius: 14,
              background: "rgba(0,0,0,0.25)",
              border: `1px solid ${weeklyOverBudget ? "rgba(255,77,109,0.5)" : "rgba(32,227,178,0.4)"}`,
              minWidth: 140,
              textAlign: "center"
            }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 4 }}>
                {weeklyOverBudget ? "OVER BUDGET BY" : "REMAINING"}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: weeklyOverBudget ? "#ff4d6d" : "#20e3b2" }}>
                {weeklyRemaining !== null ? `£${Math.abs(weeklyRemaining).toFixed(2)}` : "—"}
              </div>
            </div>
          )}

          {weeklyBudgetNum > 0 && weeklySpent !== null && (
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>
                Budget used: {Math.min(100, Math.round((weeklySpent / weeklyBudgetNum) * 100))}%
              </div>
              <div style={{ height: 10, borderRadius: 999, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  borderRadius: 999,
                  width: `${Math.min(100, (weeklySpent / weeklyBudgetNum) * 100)}%`,
                  background: weeklyOverBudget
                    ? "linear-gradient(90deg, #ff4d6d, #ff8c00)"
                    : "linear-gradient(90deg, #7c5cff, #20e3b2)",
                  transition: "width 0.4s ease"
                }} />
              </div>
              {weeklyOverBudget && (
                <p style={{ fontSize: 12, color: "#ff4d6d", marginTop: 6, marginBottom: 0 }}>
                  ⚠️ You've gone over your weekly budget. Try to cut back for the rest of the week.
                </p>
              )}
            </div>
          )}

          <button className="btn" onClick={loadWeeklySpent} disabled={loadingWeekly} style={{ alignSelf: "center" }}>
            {loadingWeekly ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>

        {!weeklyBudget && (
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 10, marginBottom: 0 }}>
            Set a weekly budget in the Budget Goals section below to see how much you have remaining.
          </p>
        )}
      </div>
      
      // First step in the flow: upload a receipt image for OCR scanning
      {/* ── UPLOAD + OCR ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>📷 Step 1: Upload Receipt</h2>
        <form onSubmit={handleUpload}>
          <p style={{ marginTop: 0, color: "rgba(255,255,255,0.65)" }}>
            Choose a JPG or PNG photo of your receipt. The image is scanned automatically and deleted immediately — it is never stored.
          </p>

          <input
            type="file"
            accept=".jpg,.jpeg,.png"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />

          <div style={{ marginTop: 12 }}>
            <button className="btn btnPrimary" type="submit" disabled={loadingOcr}>
              {loadingOcr ? "Scanning..." : "Upload & Scan Receipt"}
            </button>
          </div>

          {/* Data usage notice */}
          <div style={{
            marginTop: 12,
            padding: 12,
            border: "1px solid #cbd5e1",
            borderRadius: 10,
            background: "#bf9fd4",
            fontSize: 13,
            lineHeight: 1.5,
            color: "#0f2c54"
          }}>
            <b style={{ color: "#a11616" }}>Data Usage Notice</b>
            <div style={{ marginTop: 6 }}>
              This application stores extracted receipt information for budgeting analysis:
              <ul style={{ marginTop: 8, marginBottom: 8, paddingLeft: 18 }}>
                <li>Merchant name</li>
                <li>Transaction date</li>
                <li>Total amount</li>
                <li>OCR text (may include item/product lines — used for AI advice)</li>
              </ul>
              Receipt images are deleted immediately after OCR processing and are never permanently stored.
            </div>
          </div>

          {error && <p style={{ marginTop: 12, color: "crimson" }}>{error}</p>}
        </form>
      </div>
      
      // Second step in the flow: let the user correct OCR results before saving
      // Save button is kept here to make the order of actions clearer
      {/* ── REVIEW & EDIT + SAVE ── */}
      {result && (
        <div className="card" style={{ borderColor: "rgba(32,227,178,0.35)" }}>
          <h2 style={{ marginTop: 0 }}>✏️ Step 2: Review, Edit &amp; Save</h2>
          <p style={{ marginTop: 0, color: "rgba(255,255,255,0.65)", fontSize: 13 }}>
            The scanner has pre-filled the fields below from your receipt. Please check them carefully and correct anything that looks wrong — especially the <b>date</b> and <b>total</b>.
          </p>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12,
            marginTop: 10,
          }}>
            <div>
              <label>
                <b>Merchant</b>
                <span style={{ color: "#ff4d6d", marginLeft: 4 }}>* required</span>
              </label>
              <input
                style={{ width: "100%", marginTop: 6, padding: 8,
                  borderColor: !merchant.trim() ? "rgba(255,77,109,0.7)" : undefined }}
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder="e.g. Tesco, Costa Coffee"
              />
            </div>

            <div>
              <label>
                <b>Date</b>
                <span style={{ color: "#ff4d6d", marginLeft: 4 }}>* required</span>
              </label>
              <input
                style={{
                  width: "100%", marginTop: 6, padding: 8,
                  borderColor: !date.trim() ? "rgba(255,77,109,0.7)" : undefined
                }}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="YYYY-MM-DD (e.g. 2026-03-05)"
              />
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 4, marginBottom: 0 }}>
                Date is required so we can track your weekly spending accurately.
              </p>
            </div>

            <div>
              <label>
                <b>Total (£)</b>
                <span style={{ color: "#ff4d6d", marginLeft: 4 }}>* required</span>
              </label>
              <input
                style={{ width: "100%", marginTop: 6, padding: 8,
                  borderColor: (total === "" || total === null) ? "rgba(255,77,109,0.7)" : undefined }}
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                placeholder="e.g. 12.50"
              />
            </div>
          </div>

          <p style={{ marginTop: 12, fontSize: 13, color: "rgba(255,255,255,0.5)" }}>
            <b>Auto-detected:</b> Merchant = {result.merchant_guess || "(none)"} | Date = {result.date_guess || "(none)"} | Total = {result.total_guess ?? "(none)"}
          </p>

          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", color: "rgba(255,255,255,0.6)", fontSize: 13 }}>
              Show raw scanned text
            </summary>
            <pre style={{ whiteSpace: "pre-wrap", background: "#150d0d", padding: 12, borderRadius: 8, fontSize: 12, marginTop: 8 }}>
              {result.raw_text}
            </pre>
          </details>

          {/* Save button is HERE — in the review section */}
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <button
              className="btn btnPrimary"
              onClick={handleSave}
              disabled={loadingSave}
              style={{ fontSize: 15, padding: "12px 28px" }}
            >
              {loadingSave ? "Saving..." : "✓ Save to History"}
            </button>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 8, marginBottom: 0 }}>
              Make sure all fields are correct before saving. The date must be filled in.
            </p>
            {error && <p style={{ marginTop: 8, color: "crimson" }}>{error}</p>}
          </div>
        </div>
      )}

      // User settings that make advice more personalised
      {/* ── BUDGET GOALS ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🎯 Budget Goals</h2>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 12,
          marginTop: 10,
        }}>
          <div>
            <label><b>Weekly Budget (£)</b></label>
            <input
              style={{ width: "100%", marginTop: 6, padding: 8 }}
              placeholder="e.g. 40"
              value={weeklyBudget}
              onChange={(e) => {
                setWeeklyBudget(e.target.value);
              }}
            />
          </div>
          <div>
            <label><b>Lifestyle Goal</b></label>
            <select
              style={{ width: "100%", marginTop: 6, padding: 8 }}
              value={lifestyleGoal}
              onChange={(e) => setLifestyleGoal(e.target.value)}
            >
              <option>Healthy</option>
              <option>Cheap</option>
              <option>Balanced</option>
              <option>High Protein</option>
              <option>Vegetarian</option>
            </select>
          </div>
        </div>
        <p style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
          Your budget and goal are used to personalise advice and calculate your weekly spending tracker above.
        </p>
      </div>

      // Shows item-level product totals extracted from receipts
      // This helps prove that advice is based on actual products, not only receipt totals
      {/* ── ITEM BREAKDOWN ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🛒 Product Breakdown (Last 30 Days)</h2>
        <p style={{ marginTop: 0, fontSize: 13, color: "rgba(255,255,255,0.55)" }}>
          Individual products extracted from your receipts by AI. These are used to generate personalised advice.
        </p>

        <button className="btn" onClick={loadItemSubtotals} disabled={loadingItems} style={{ marginBottom: 12 }}>
          {loadingItems ? "Loading..." : "↻ Refresh"}
        </button>

        {itemSubtotals.length === 0 ? (
          <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13 }}>
            No items extracted yet. Save a receipt — AI will automatically identify the products purchased.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Product / Service", "Times Bought", "Monthly Total", "Avg per Purchase"].map(h => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.12)", padding: "8px 10px", fontSize: 12, color: "rgba(255,255,255,0.55)", fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {itemSubtotals.map((item, idx) => (
                  <tr key={idx}>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 13 }}>{item.name}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 13 }}>{item.purchase_count}x</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 13, fontWeight: 600, color: "#20e3b2" }}>£{item.monthly_total.toFixed(2)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 13, color: "rgba(255,255,255,0.55)" }}>
                      £{(item.monthly_total / item.purchase_count).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      
      // Advice panel
      // Uses backend advice which may come from OpenAI or from fallback logic if AI is unavailable
      {/* ── AI ADVICE ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🤖 Personalised AI Advice</h2>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <button className="btn btnPrimary" onClick={loadAdvice} disabled={loadingAdvice}>
            {loadingAdvice ? "Thinking..." : "Get Advice"}
          </button>
          {adviceSource && (
            <span style={{ fontSize: 13, color: "#555" }}>
              Source: <b>{adviceSource === "openai" ? "ChatGPT (GPT-4o mini)" : "Built-in tips"}</b>
            </span>
          )}
        </div>

        {adviceError && <p style={{ color: "crimson" }}>{adviceError}</p>}

        {advice.length === 0 ? (
          <p style={{ margin: 0, color: "rgba(255,255,255,0.5)" }}>
            No advice yet. Save a receipt first, then click <b>Get Advice</b>.
          </p>
        ) : (
          <ul style={{ marginTop: 10, paddingLeft: 20 }}>
            {advice.map((tip, idx) => (
              <li key={idx} style={{ marginBottom: 10, lineHeight: 1.6 }}>
                {tip}
              </li>
            ))}
          </ul>
        )}

        <p style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
          Advice is generated from your receipt history including item-level detail where available. Always use your own judgement for financial decisions.
        </p>
      </div>
      
      // Spending charts to help the user understand patterns over time
      {/* ── CHARTS ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>📈 Spending Charts</h2>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => loadSummary(30)} disabled={loadingSummary}>
            {loadingSummary ? "Loading..." : "Refresh (30 days)"}
          </button>
        </div>

        {summaryError && <p style={{ color: "crimson" }}>{summaryError}</p>}

        {!summary ? (
          <p>No chart data yet. Save at least one receipt.</p>
        ) : (
          <>
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 8 }}>Spending Trend (Daily Totals)</h3>
              <Line
                data={{
                  labels: summary.daily_totals.map((d) => d.day),
                  datasets: [{
                    label: "Total spend (£)",
                    data: summary.daily_totals.map((d) => d.total),
                    borderColor: "#2563eb",
                    backgroundColor: "#93c5fd",
                    tension: 0.3
                  }],
                }}
                options={{
                  responsive: true,
                  plugins: { legend: { display: true } },
                  scales: {
                    x: { grid: { color: "#696d56" } },
                    y: { grid: { color: "#6f705e" } }
                  }
                }}
              />
            </div>
            <div>
              <h3 style={{ marginBottom: 8 }}>Top Merchants (Last 30 days)</h3>
              <Bar
                data={{
                  labels: summary.merchant_totals.map((m) => m.merchant),
                  datasets: [{
                    label: "Total spend (£)",
                    data: summary.merchant_totals.map((m) => m.total),
                    backgroundColor: "#2563eb"
                  }],
                }}
                options={{
                  responsive: true,
                  plugins: { legend: { display: true } },
                  scales: {
                    x: { grid: { color: "#6a704a" } },
                    y: { grid: { color: "#6e7256" } }
                  }
                }}
              />
            </div>
          </>
        )}
      </div>
      
      // Receipt history saved in SQLite
      // Users can review, export or delete saved records
      {/* ── HISTORY ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🗂️ History (SQLite)</h2>
        <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={loadHistory}>Refresh</button>
          <a href="http://127.0.0.1:5000/api/export.csv" target="_blank" rel="noreferrer">Export CSV</a>
          <span>|</span>
          <a href="http://127.0.0.1:5000/api/export.json" target="_blank" rel="noreferrer">Export JSON</a>
        </div>

        {historyError && <p style={{ color: "crimson" }}>{historyError}</p>}

        {history.length === 0 ? (
          <p>No receipts saved yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 650 }}>
              <thead>
                <tr>
                  {["ID", "Merchant", "Date", "Total", "Created", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>{r.id}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>{r.merchant}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>{r.date || <span style={{ color: "#ff4d6d", fontSize: 12 }}>no date</span>}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>£{r.total}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>{r.created_at}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>
                      <button className="btn btnDanger" onClick={() => handleDelete(r.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
