import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Desktop landing — faithful port of the "Grace Landing.dc.html" Claude Design
 * handoff: a 12-section horizontal slide deck (Newsreader serif + Hanken
 * Grotesque, warm cream + terracotta) with wheel / keyboard / touch navigation,
 * a dot rail, and prev/next controls. Desktop only — the phone keeps its own
 * iMessage hero, untouched.
 */

const ACCENT = "#C57A57";
const SERIF = "'Newsreader',Georgia,serif";

const PAGES = [
  "Welcome", "The hard part", "Meet Grace", "Why different", "How it works",
  "A day with Grace", "Safety", "Benefits", "Stories", "Pricing", "FAQ", "Start",
];

const worries = [
  "What should I eat today?", "Am I getting enough protein?", "Did I drink enough water?",
  "Is this side effect normal?", "When is my injection day?", "I forgot to track again.",
  "I don't want another complicated app.",
];
const capabilities = [
  { num: "01", t: "Smart food logging", d: "Just say what you ate — Grace handles the rest." },
  { num: "02", t: "Protein & calorie awareness", d: "Gentle nudges that help you hit your goals." },
  { num: "03", t: "Injection day support", d: "A calm reminder when your day comes around." },
  { num: "04", t: "Friendly daily reminders", d: "Water, meals, and routine — never nagging." },
  { num: "05", t: "Personalized guidance", d: "Grace remembers your preferences and routine." },
  { num: "06", t: "Voice & image support", d: "Type, talk, or snap a photo of your plate." },
  { num: "07", t: "Progress tracking", d: "Watch your consistency build, day by day." },
  { num: "08", t: "Warm check-ins", d: "A little encouragement, exactly when you need it." },
];
const notThis = ["Complicated dashboards", "Judgment or shame", "Generic, copy-paste advice", "Pressure to be perfect"];
const butThis = ["Understands your context", "Asks when it's unsure", "Replies short & personal", "Helps you stay consistent, gently"];
const steps = [
  { n: "01", t: "Tell Grace about you", d: "Set your goals, preferences, medication, injection day, and routine." },
  { n: "02", t: "Message Grace naturally", d: "Log meals, ask questions, share symptoms, or just say what you ate." },
  { n: "03", t: "Stay supported every day", d: "Helpful reminders, progress support, and guidance that fits your journey." },
];
type Msg = { text: string; isGrace: boolean };
const mockups: Array<{ caption: string; messages: Msg[] }> = [
  { caption: "Logging a meal is just a message.", messages: [
    { text: "Had Greek yogurt and berries", isGrace: false },
    { text: "Got it — I'll log that as a high-protein snack. 💛", isGrace: true } ] },
  { caption: "Mornings that start gently.", messages: [
    { text: "Morning 💛 Yesterday you focused on protein — today let's keep it simple: start with something easy and protein-rich.", isGrace: true } ] },
  { caption: "A calm nudge on the day that matters.", messages: [
    { text: "Today is your injection day. Try to stay hydrated and keep meals gentle. I'm right here if you need anything.", isGrace: true } ] },
  { caption: "Never wonder “what do I eat?” alone.", messages: [
    { text: "What can I eat for dinner?", isGrace: false },
    { text: "Something light and protein-focused could work well — grilled chicken, eggs, cottage cheese, or tofu, depending on what you're in the mood for.", isGrace: true } ] },
];
const safety = [
  "Grace is not a doctor and does not replace medical advice.",
  "For serious symptoms, contact a healthcare professional.",
  "Grace supports daily habits, tracking, reminders, and general wellness.",
  "Your privacy and safety always come first.",
];
const benefits = ["Feel less alone", "Stay consistent", "Understand your eating better", "Hit protein goals more easily", "Remember injection days", "Build simple routines", "Support without judgment", "Less time guessing"];
const testimonials = [
  { q: "Grace made tracking feel easy instead of stressful.", n: "Maya R.", meta: "4 months in" },
  { q: "I finally have something that reminds me without making me feel bad.", n: "Daniel K.", meta: "On Wegovy" },
  { q: "It feels like someone is actually checking in on me.", n: "Priya S.", meta: "On Mounjaro" },
].map((t) => ({ ...t, initials: t.n.split(" ").map((s) => s[0]).join("").slice(0, 2) }));
const freeFeats = ["Full access for 7 days", "Meal & protein logging", "Daily reminders", "No commitment"];
const proFeats = ["Everything in Free", "Voice & image logging", "Personalized guidance", "Progress tracking", "Injection day support"];
const FAQ = [
  { q: "Is Grace a medical app?", a: "No. Grace is a supportive wellness companion for daily habits, tracking, and reminders. It doesn't diagnose, treat, or provide medical advice." },
  { q: "Does Grace replace my doctor?", a: "Never. Grace supports your day-to-day routine, but your healthcare provider is always your source for medical decisions." },
  { q: "Can Grace help me track protein?", a: "Yes. Just tell Grace what you ate and it'll help you stay aware of your protein and keep your goals in sight." },
  { q: "Can Grace remind me about injection day?", a: "Yes. Set your schedule once and Grace will send a calm, friendly reminder when your day comes around." },
  { q: "Can I use Grace on Ozempic, Wegovy, Mounjaro, or Zepbound?", a: "Yes. Grace is built to support people across common GLP-1 medications and routines." },
  { q: "Can Grace understand my food preferences?", a: "Yes. Grace remembers what you like, what you avoid, and tailors its suggestions to you." },
  { q: "Can I stop messages anytime?", a: "Of course. You're always in control — pause, adjust, or turn off reminders whenever you like." },
  { q: "Is Grace easy to use?", a: "Very. If you can send a text message, you already know how to use Grace." },
];

const eyebrow = (color = ACCENT): CSSProperties => ({ fontSize: "12.5px", fontWeight: 700, letterSpacing: "2.5px", textTransform: "uppercase", color, marginBottom: "16px" });
const h2: CSSProperties = { fontFamily: SERIF, fontWeight: 500, lineHeight: 1.07, letterSpacing: "-.6px", color: "#2B2722", margin: 0 };
const pageInner: CSSProperties = { minHeight: "100%", display: "flex", flexDirection: "column", justifyContent: "center", boxSizing: "border-box", padding: "96px 0 80px" };
const container = (w: number): CSSProperties => ({ width: `min(${w}px,90vw)`, marginInline: "auto" });

function Page({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <section className="gpage" style={{ flex: "0 0 100vw", width: "100vw", height: "100%", overflowY: "auto", background: bg }}>
      <div style={pageInner}>{children}</div>
    </section>
  );
}

const DesktopDeck = () => {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [openFaq, setOpenFaq] = useState(0);
  const lock = useRef(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const start = () => startWithGrace(() => navigate("/onboarding"));

  const total = PAGES.length;
  const goTo = (i: number) => setPage((p) => { const n = Math.max(0, Math.min(total - 1, i)); return n === p ? p : n; });
  const next = () => goTo(pageRef.current + 1);
  const prev = () => goTo(pageRef.current - 1);
  const pageRef = useRef(0);
  pageRef.current = page;

  useEffect(() => {
    if (trackRef.current) trackRef.current.style.transform = `translateX(-${page * 100}vw)`;
  }, [page]);

  useEffect(() => {
    const activeEl = () => rootRef.current?.querySelectorAll<HTMLElement>(".gpage")[pageRef.current] ?? null;
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowDown", "PageDown", "ArrowRight"].includes(e.key)) { e.preventDefault(); next(); }
      else if (["ArrowUp", "PageUp", "ArrowLeft"].includes(e.key)) { e.preventDefault(); prev(); }
      else if (e.key === "Home") goTo(0);
      else if (e.key === "End") goTo(total - 1);
    };
    const onWheel = (e: WheelEvent) => {
      const el = activeEl();
      if (!el) return;
      const canScroll = el.scrollHeight > el.clientHeight + 2;
      const atTop = el.scrollTop <= 1;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const down = e.deltaY > 0;
      if (canScroll && ((down && !atBottom) || (!down && !atTop))) return;
      if (Math.abs(e.deltaY) < 8 || lock.current) return;
      lock.current = true;
      window.setTimeout(() => { lock.current = false; }, 850);
      if (down) next(); else prev();
    };
    const onTouchStart = (e: TouchEvent) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; };
    const onTouchEnd = (e: TouchEvent) => {
      if (!touch.current) return;
      const el = activeEl(); const t = e.changedTouches[0];
      const dy = t.clientY - touch.current.y; const dx = t.clientX - touch.current.x;
      touch.current = null;
      if (!el || Math.abs(dx) > Math.abs(dy) || Math.abs(dy) < 55) return;
      const canScroll = el.scrollHeight > el.clientHeight + 2;
      const atTop = el.scrollTop <= 1; const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if (dy < 0) { if (canScroll && !atBottom) return; next(); } else { if (canScroll && !atTop) return; prev(); }
    };
    window.addEventListener("keydown", onKey);
    const r = rootRef.current;
    r?.addEventListener("wheel", onWheel, { passive: true });
    r?.addEventListener("touchstart", onTouchStart, { passive: true });
    r?.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      r?.removeEventListener("wheel", onWheel);
      r?.removeEventListener("touchstart", onTouchStart);
      r?.removeEventListener("touchend", onTouchEnd);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pad = (x: number) => (x < 10 ? "0" + x : "" + x);

  return (
    <div
      ref={rootRef}
      className="hidden lg:block"
      style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#F6F1E8", color: "#2B2722", fontFamily: "'Hanken Grotesque',-apple-system,sans-serif", WebkitFontSmoothing: "antialiased", zIndex: 40 }}
    >
      {/* HEADER */}
      <header style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 70, background: "linear-gradient(180deg,rgba(246,241,232,.9),rgba(246,241,232,0))", backdropFilter: "blur(6px)" }}>
        <nav style={{ width: "min(1180px,92vw)", marginInline: "auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: "18px 0" }}>
          <div onClick={() => goTo(0)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <span style={{ width: 30, height: 30, borderRadius: "50%", background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontFamily: SERIF, fontSize: 18, fontWeight: 500 }}>G</span>
            <span style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 500, letterSpacing: "-.3px", color: "#2B2722" }}>Grace</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            {[["How it works", 4], ["Features", 5], ["Safety", 6], ["Pricing", 9]].map(([label, i]) => (
              <span key={label as string} onClick={() => goTo(i as number)} style={{ cursor: "pointer", color: "#6F665B", fontSize: "14.5px", fontWeight: 500 }}>{label}</span>
            ))}
            <span onClick={start} style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#2B2722", color: "#FBF6EE", padding: "11px 20px", borderRadius: 30, fontSize: "14.5px", fontWeight: 600, cursor: "pointer" }}>Start with Grace</span>
          </div>
        </nav>
      </header>

      {/* SLIDING TRACK */}
      <div ref={trackRef} style={{ display: "flex", height: "100%", width: "100%", transition: "transform .68s cubic-bezier(.72,0,.18,1)", willChange: "transform" }}>

        {/* 0 · HERO */}
        <Page bg="linear-gradient(180deg,#F6F1E8 0%,#F1E8DA 100%)">
          <div style={{ width: "min(1120px,90vw)", marginInline: "auto", display: "flex", alignItems: "center", gap: "clamp(32px,5vw,72px)", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 420px", minWidth: 290 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "#fff", border: "1px solid #E7DDCD", color: "#6F665B", padding: "8px 16px", borderRadius: 30, fontSize: "12.5px", fontWeight: 600 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: ACCENT }} />
                For Ozempic · Wegovy · Mounjaro · Zepbound
              </span>
              <h1 style={{ fontFamily: SERIF, fontWeight: 500, fontSize: "clamp(36px,5vw,60px)", lineHeight: 1.03, letterSpacing: "-.8px", color: "#2B2722", margin: "22px 0 0", maxWidth: "15ch" }}>Your GLP-1 journey, with support that actually feels <em style={{ fontStyle: "italic", color: ACCENT }}>personal</em>.</h1>
              <p style={{ fontSize: "clamp(16px,1.4vw,18.5px)", lineHeight: 1.6, color: "#6F665B", margin: "22px 0 0", maxWidth: "46ch" }}>Grace helps you track meals, protein, reminders, symptoms, and daily progress — with warm support that feels more like a companion than another app.</p>
              <div style={{ display: "flex", gap: 13, flexWrap: "wrap", marginTop: 30 }}>
                <span onClick={start} style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "#2B2722", color: "#FBF6EE", padding: "15px 28px", borderRadius: 40, fontSize: "15.5px", fontWeight: 600, cursor: "pointer", boxShadow: "0 16px 32px -14px rgba(43,39,34,.55)" }}>Start with Grace <span style={{ fontSize: 17 }}>→</span></span>
                <span onClick={() => goTo(4)} style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#2B2722", padding: "15px 24px", borderRadius: 40, fontSize: "15.5px", fontWeight: 600, cursor: "pointer", border: "1.5px solid #D8CCB8" }}>See how it works</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 30 }}>
                <div style={{ display: "flex" }}>
                  <span style={{ width: 32, height: 32, borderRadius: "50%", background: "#ECEFE2", border: "2px solid #F1E8DA" }} />
                  <span style={{ width: 32, height: 32, borderRadius: "50%", background: "#F2DECF", border: "2px solid #F1E8DA", marginLeft: -11 }} />
                  <span style={{ width: 32, height: 32, borderRadius: "50%", background: "#E4D8C5", border: "2px solid #F1E8DA", marginLeft: -11 }} />
                </div>
                <span style={{ fontSize: 14, color: "#6F665B", lineHeight: 1.4, maxWidth: "28ch" }}>Join thousands building daily consistency with Grace.</span>
              </div>
            </div>
            <div style={{ flex: "1 1 300px", display: "flex", justifyContent: "center", minWidth: 260 }}>
              <div style={{ position: "relative", width: "min(300px,80vw)", animation: "gdeck-floaty 7s ease-in-out infinite" }}>
                <div style={{ background: "#211D19", borderRadius: 48, padding: 10, boxShadow: "0 50px 90px -34px rgba(43,39,34,.5),0 14px 34px -14px rgba(43,39,34,.28)" }}>
                  <div style={{ position: "relative", background: "#F7F3EC", borderRadius: 38, overflow: "hidden", height: 560, display: "flex", flexDirection: "column" }}>
                    <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", width: 88, height: 25, background: "#211D19", borderRadius: 16, zIndex: 5 }} />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px 8px", fontSize: "12.5px", fontWeight: 600, color: "#2B2722" }}>
                      <span>9:41</span>
                      <span style={{ fontSize: 11 }}>● ▂▄▆</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 18px 12px", borderBottom: "1px solid #ECE3D5" }}>
                      <div style={{ width: 36, height: 36, borderRadius: "50%", background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontFamily: SERIF, fontSize: 19, fontWeight: 500 }}>G</div>
                      <div style={{ flex: 1 }}><div style={{ fontSize: "14.5px", fontWeight: 700, color: "#2B2722" }}>Grace</div><div style={{ fontSize: 11, color: "#8FA07E", fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "#8FA07E" }} />Your GLP-1 companion</div></div>
                      <div style={{ color: "#B6AD9F", fontSize: 19, lineHeight: 0 }}>···</div>
                    </div>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 11, padding: "18px 15px" }}>
                      <GraceBubble>Morning 💛 How are you feeling today?</GraceBubble>
                      <UserBubble>Pretty good! I had chicken and rice for lunch</UserBubble>
                      <GraceBubble>Nice — was the chicken grilled or fried? That helps me log it more accurately 💛</GraceBubble>
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}><GraceAvatar /><div style={{ background: "#fff", border: "1px solid #EEE4D5", borderRadius: "17px 17px 17px 5px", padding: "13px 15px", display: "flex", gap: 5, alignItems: "center" }}>{[0, 0.2, 0.4].map((d) => <span key={d} style={{ width: 7, height: 7, borderRadius: "50%", background: "#C2B8A8", animation: `gdeck-blink 1.2s infinite ${d}s` }} />)}</div></div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 15px 16px", borderTop: "1px solid #ECE3D5", background: "#FBF7F0" }}><div style={{ flex: 1, background: "#fff", border: "1px solid #E7DDCD", borderRadius: 22, padding: "10px 15px", fontSize: 13, color: "#A89E8F" }}>Message Grace…</div><div style={{ width: 38, height: 38, borderRadius: "50%", background: "#2B2722", display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontSize: 16 }}>↑</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Page>

        {/* 1 · PROBLEM */}
        <Page bg="#EFE7D9">
          <div style={container(1020)}>
            <div style={eyebrow()}>The hard part</div>
            <h2 style={{ ...h2, fontSize: "clamp(30px,4vw,50px)", lineHeight: 1.08, maxWidth: "18ch" }}>GLP-1 works best with daily support. Most people are left figuring it out alone.</h2>
            <p style={{ fontSize: "clamp(16px,1.4vw,18px)", lineHeight: 1.65, color: "#6F665B", margin: "22px 0 0", maxWidth: "50ch" }}>The questions are constant, the routine is new, and there's a lot to keep track of. It's easy to feel overwhelmed — and easier to fall off.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 13, marginTop: 42 }}>
              {worries.map((w) => <div key={w} style={{ background: "#FBF8F2", border: "1px solid #E6DBC9", borderRadius: 40, padding: "14px 23px", fontFamily: SERIF, fontStyle: "italic", fontSize: "clamp(15px,1.5vw,18.5px)", color: "#4A4339", boxShadow: "0 2px 6px -3px rgba(43,39,34,.1)" }}>“{w}”</div>)}
            </div>
          </div>
        </Page>

        {/* 2 · SOLUTION */}
        <Page bg="#F6F1E8">
          <div style={container(1080)}>
            <div style={eyebrow()}>Meet Grace</div>
            <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,46px)", lineHeight: 1.06, maxWidth: "16ch" }}>Your simple daily companion.</h2>
            <p style={{ fontSize: "clamp(15px,1.3vw,17.5px)", lineHeight: 1.6, color: "#6F665B", margin: "18px 0 0", maxWidth: "56ch" }}>Grace checks in, remembers your preferences, helps you log meals, tracks your protein, supports your routine, and sends gentle reminders — all through a friendly conversation.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: "0 clamp(28px,4vw,64px)", marginTop: 34 }}>
              {capabilities.map((c) => (
                <div key={c.num} style={{ padding: "18px 2px", borderTop: "1px solid #E2D8C8" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 13 }}>
                    <span style={{ fontFamily: SERIF, fontSize: 14, color: ACCENT, fontWeight: 500, flexShrink: 0 }}>{c.num}</span>
                    <div><div style={{ fontSize: "17.5px", fontWeight: 600, color: "#2B2722", letterSpacing: "-.2px" }}>{c.t}</div><div style={{ fontSize: 14, color: "#6F665B", lineHeight: 1.5, marginTop: 5 }}>{c.d}</div></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Page>

        {/* 3 · WHY DIFFERENT */}
        <Page bg="#FBF8F2">
          <div style={container(1040)}>
            <div style={eyebrow()}>Why Grace feels different</div>
            <h2 style={{ ...h2, fontSize: "clamp(28px,4vw,52px)", lineHeight: 1.04, letterSpacing: "-.7px", margin: "0 0 44px", maxWidth: "20ch" }}>Not another tracking app. A companion that actually <em style={{ fontStyle: "italic", color: ACCENT }}>talks to you</em>.</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: "clamp(28px,4vw,56px)" }}>
              <div>
                <div style={{ fontSize: "12.5px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "#A89E8F", marginBottom: 4 }}>What you won't find</div>
                {notThis.map((n) => <div key={n} style={{ display: "flex", alignItems: "center", gap: 13, padding: "15px 0", borderBottom: "1px solid #ECE2D2" }}><span style={{ width: 21, height: 21, borderRadius: "50%", border: "1.5px solid #D8CCB8", color: "#B6AD9F", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>×</span><span style={{ fontSize: 16, color: "#8C8377", fontWeight: 500 }}>{n}</span></div>)}
              </div>
              <div>
                <div style={{ fontSize: "12.5px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: ACCENT, marginBottom: 4 }}>What you get instead</div>
                {butThis.map((b) => <div key={b} style={{ display: "flex", alignItems: "center", gap: 13, padding: "15px 0", borderBottom: "1px solid #ECE2D2" }}><span style={{ width: 21, height: 21, borderRadius: "50%", background: ACCENT, color: "#FBF6EE", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>✓</span><span style={{ fontSize: 16, color: "#2B2722", fontWeight: 600 }}>{b}</span></div>)}
              </div>
            </div>
          </div>
        </Page>

        {/* 4 · HOW IT WORKS */}
        <Page bg="#EFE7D9">
          <div style={container(1080)}>
            <div style={{ textAlign: "center", maxWidth: 620, margin: "0 auto 44px" }}>
              <div style={eyebrow()}>How it works</div>
              <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,48px)", lineHeight: 1.08 }}>Three easy steps. That's it.</h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: "clamp(18px,3vw,28px)" }}>
              {steps.map((s) => (
                <div key={s.n} style={{ background: "#FBF8F2", border: "1px solid #E6DBC9", borderRadius: 24, padding: "32px 30px", boxShadow: "0 16px 38px -28px rgba(43,39,34,.3)" }}>
                  <div style={{ fontFamily: SERIF, fontSize: 46, color: ACCENT, lineHeight: 1, fontWeight: 500 }}>{s.n}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, margin: "16px 0 10px", color: "#2B2722", letterSpacing: "-.3px" }}>{s.t}</div>
                  <div style={{ fontSize: 15, color: "#6F665B", lineHeight: 1.55 }}>{s.d}</div>
                </div>
              ))}
            </div>
          </div>
        </Page>

        {/* 5 · A DAY WITH GRACE */}
        <Page bg="#F6F1E8">
          <div style={{ width: "min(1120px,92vw)", marginInline: "auto" }}>
            <div style={{ maxWidth: 620, marginBottom: 34 }}>
              <div style={eyebrow()}>A day with Grace</div>
              <h2 style={{ ...h2, fontSize: "clamp(26px,3.4vw,44px)", lineHeight: 1.08, maxWidth: "20ch" }}>Real moments, handled with a single message.</h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "clamp(20px,3vw,36px)" }}>
              {mockups.map((m) => (
                <div key={m.caption} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#6F665B", lineHeight: 1.4, minHeight: 38 }}>{m.caption}</div>
                  <div style={{ background: "#211D19", borderRadius: 34, padding: 8, boxShadow: "0 30px 60px -34px rgba(43,39,34,.45)" }}>
                    <div style={{ background: "#F7F3EC", borderRadius: 27, overflow: "hidden", height: 386, display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 14px 10px", borderBottom: "1px solid #ECE3D5" }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontFamily: SERIF, fontSize: 15, fontWeight: 500, flexShrink: 0 }}>G</div>
                        <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: "#2B2722" }}>Grace</div><div style={{ fontSize: 10, color: "#8FA07E", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: "#8FA07E" }} />online</div></div>
                      </div>
                      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 9, padding: "14px 12px" }}>
                        {m.messages.map((msg, i) => msg.isGrace
                          ? <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-end", maxWidth: "92%" }}><div style={{ width: 21, height: 21, borderRadius: "50%", background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontFamily: SERIF, fontSize: 11, flexShrink: 0 }}>G</div><div style={{ background: "#fff", border: "1px solid #EEE4D5", color: "#2B2722", padding: "9px 12px", borderRadius: "15px 15px 15px 5px", fontSize: 13, lineHeight: 1.5 }}>{msg.text}</div></div>
                          : <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}><div style={{ background: "#ECCDBC", color: "#3A2E26", padding: "9px 12px", borderRadius: "15px 15px 5px 15px", fontSize: 13, lineHeight: 1.5, maxWidth: "84%" }}>{msg.text}</div></div>)}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 12px 14px", borderTop: "1px solid #ECE3D5", background: "#FBF7F0" }}><div style={{ flex: 1, background: "#fff", border: "1px solid #E7DDCD", borderRadius: 18, padding: "8px 13px", fontSize: 12, color: "#A89E8F" }}>Message Grace…</div><div style={{ width: 32, height: 32, borderRadius: "50%", background: "#2B2722", display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontSize: 14, flexShrink: 0 }}>↑</div></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Page>

        {/* 6 · SAFETY */}
        <Page bg="#ECEFE2">
          <div style={{ width: "min(900px,90vw)", marginInline: "auto", textAlign: "center" }}>
            <div style={eyebrow("#6F7E5B")}>Trust &amp; safety</div>
            <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,46px)", lineHeight: 1.08 }}>Supportive, safe, and built for real life.</h2>
            <p style={{ fontSize: "clamp(15px,1.3vw,17.5px)", lineHeight: 1.65, color: "#55604A", margin: "20px auto 0", maxWidth: "48ch" }}>Grace is not a doctor and doesn't replace medical advice. For serious or unusual symptoms, please contact a healthcare professional. Grace is here for daily habits, tracking, reminders, and gentle wellness support.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 16, marginTop: 40, textAlign: "left" }}>
              {safety.map((sf) => <div key={sf} style={{ background: "#FBFCF7", border: "1px solid #DDE4CF", borderRadius: 18, padding: 22, display: "flex", gap: 12, alignItems: "flex-start" }}><span style={{ width: 9, height: 9, borderRadius: "50%", background: "#8FA07E", marginTop: 7, flexShrink: 0 }} /><span style={{ fontSize: "14.5px", color: "#3D4534", lineHeight: 1.5, fontWeight: 500 }}>{sf}</span></div>)}
            </div>
          </div>
        </Page>

        {/* 7 · BENEFITS (dark) */}
        <Page bg="#211D19">
          <div style={{ ...container(1040), color: "#F3EDE2" }}>
            <div style={{ maxWidth: 620 }}>
              <div style={eyebrow("#E0B486")}>What changes</div>
              <h2 style={{ ...h2, color: "#FBF6EE", fontSize: "clamp(28px,3.8vw,48px)", lineHeight: 1.08, maxWidth: "18ch" }}>Less guessing, less alone, more daily progress.</h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "4px 40px", marginTop: 36 }}>
              {benefits.map((bn) => <div key={bn} style={{ display: "flex", alignItems: "center", gap: 15, padding: "17px 0", borderBottom: "1px solid rgba(243,237,226,.13)" }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#E0B486", flexShrink: 0 }} /><span style={{ fontSize: "clamp(16px,1.5vw,19px)", color: "#F3EDE2", fontWeight: 500, letterSpacing: "-.2px" }}>{bn}</span></div>)}
            </div>
          </div>
        </Page>

        {/* 8 · TESTIMONIALS */}
        <Page bg="#F6F1E8">
          <div style={container(1080)}>
            <div style={{ textAlign: "center", maxWidth: 620, margin: "0 auto 40px" }}>
              <div style={eyebrow()}>In their words</div>
              <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,48px)", lineHeight: 1.08 }}>People feel the difference.</h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(270px,1fr))", gap: "clamp(18px,3vw,28px)" }}>
              {testimonials.map((t) => (
                <div key={t.n} style={{ background: "#fff", border: "1px solid #EADFCD", borderRadius: 24, padding: 30, display: "flex", flexDirection: "column", gap: 18, boxShadow: "0 20px 44px -32px rgba(43,39,34,.3)" }}>
                  <div style={{ color: ACCENT, fontSize: 13, letterSpacing: 3 }}>★★★★★</div>
                  <div style={{ fontFamily: SERIF, fontSize: "19.5px", lineHeight: 1.45, color: "#2B2722" }}>“{t.q}”</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: "auto" }}><div style={{ width: 42, height: 42, borderRadius: "50%", background: "#ECEFE2", color: "#6F7E5B", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14 }}>{t.initials}</div><div><div style={{ fontWeight: 700, fontSize: "14.5px", color: "#2B2722" }}>{t.n}</div><div style={{ fontSize: "12.5px", color: "#9B9183", marginTop: 2 }}>{t.meta}</div></div></div>
                </div>
              ))}
            </div>
          </div>
        </Page>

        {/* 9 · PRICING */}
        <Page bg="#EFE7D9">
          <div style={{ width: "min(780px,90vw)", marginInline: "auto" }}>
            <div style={{ textAlign: "center", maxWidth: 600, margin: "0 auto 36px" }}>
              <div style={eyebrow()}>Get started</div>
              <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,48px)", lineHeight: 1.06, letterSpacing: "-.7px" }}>Start your journey with support that feels personal.</h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(270px,1fr))", gap: 22, alignItems: "stretch" }}>
              <div style={{ background: "#FBF8F2", border: "1px solid #E6DBC9", borderRadius: 26, padding: "34px 30px", display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: "13.5px", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#9B9183" }}>Free Trial</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "14px 0 4px" }}><span style={{ fontFamily: SERIF, fontSize: 48, fontWeight: 500, color: "#2B2722", lineHeight: 1 }}>$0</span><span style={{ fontSize: 14, color: "#9B9183" }}>for 7 days</span></div>
                <div style={{ fontSize: "14.5px", color: "#6F665B", lineHeight: 1.5, marginBottom: 22 }}>Experience daily support with Grace, free.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 11, marginBottom: 26 }}>
                  {freeFeats.map((f) => <div key={f} style={{ display: "flex", alignItems: "center", gap: 11, fontSize: "14.5px", color: "#4A4339" }}><span style={{ width: 19, height: 19, borderRadius: "50%", background: "#EADFCD", color: "#8C8377", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0 }}>✓</span>{f}</div>)}
                </div>
                <span onClick={start} style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 14, borderRadius: 34, border: "1.5px solid #2B2722", color: "#2B2722", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Start free</span>
              </div>
              <div style={{ position: "relative", background: "#2B2722", borderRadius: 26, padding: "34px 30px", display: "flex", flexDirection: "column", boxShadow: "0 30px 60px -30px rgba(43,39,34,.6)" }}>
                <div style={{ position: "absolute", top: 20, right: 22, background: ACCENT, color: "#FBF6EE", fontSize: "10.5px", fontWeight: 700, letterSpacing: ".8px", textTransform: "uppercase", padding: "6px 12px", borderRadius: 20 }}>Most loved</div>
                <div style={{ fontSize: "13.5px", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#E0B486" }}>Pro</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "14px 0 4px" }}><span style={{ fontFamily: SERIF, fontSize: 48, fontWeight: 500, color: "#FBF6EE", lineHeight: 1 }}>$15</span><span style={{ fontSize: "13.5px", color: "#B9AE9E" }}>per month</span></div>
                <div style={{ fontSize: "14.5px", color: "#C9BEAE", lineHeight: 1.5, marginBottom: 22 }}>Your everyday companion, always there.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 11, marginBottom: 26 }}>
                  {proFeats.map((f) => <div key={f} style={{ display: "flex", alignItems: "center", gap: 11, fontSize: "14.5px", color: "#EDE5D7" }}><span style={{ width: 19, height: 19, borderRadius: "50%", background: ACCENT, color: "#FBF6EE", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0 }}>✓</span>{f}</div>)}
                </div>
                <span onClick={start} style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, borderRadius: 34, background: "#FBF6EE", color: "#2B2722", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Start with Grace →</span>
              </div>
            </div>
            <p style={{ textAlign: "center", fontSize: "12.5px", color: "#9B9183", margin: "24px auto 0", maxWidth: "48ch", lineHeight: 1.6 }}>Grace is a wellness companion, not a medical device or healthcare provider. Cancel anytime.</p>
          </div>
        </Page>

        {/* 10 · FAQ */}
        <Page bg="#F6F1E8">
          <div style={{ width: "min(800px,90vw)", marginInline: "auto" }}>
            <div style={{ textAlign: "center", marginBottom: 34 }}>
              <div style={eyebrow()}>Good to know</div>
              <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,48px)", lineHeight: 1.08 }}>Questions, answered simply.</h2>
            </div>
            <div style={{ borderBottom: "1px solid #E2D8C8" }}>
              {FAQ.map((f, i) => (
                <div key={f.q} style={{ borderTop: "1px solid #E2D8C8" }}>
                  <div onClick={() => setOpenFaq((o) => (o === i ? -1 : i))} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 24, padding: "18px 4px", cursor: "pointer" }}><span style={{ fontSize: "clamp(15.5px,1.5vw,18px)", fontWeight: 600, color: "#2B2722", letterSpacing: "-.2px" }}>{f.q}</span><span style={{ fontFamily: SERIF, fontSize: 26, color: ACCENT, lineHeight: 1, flexShrink: 0, width: 22, textAlign: "center" }}>{openFaq === i ? "–" : "+"}</span></div>
                  {openFaq === i && <div style={{ padding: "0 4px 20px", maxWidth: "62ch", fontSize: 15, color: "#6F665B", lineHeight: 1.65 }}>{f.a}</div>}
                </div>
              ))}
            </div>
          </div>
        </Page>

        {/* 11 · CLOSING */}
        <Page bg="linear-gradient(135deg,#211D19 0%,#332A22 100%)">
          <div style={{ width: "min(760px,90vw)", marginInline: "auto", textAlign: "center" }}>
            <span style={{ width: 46, height: 46, borderRadius: "50%", background: ACCENT, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontFamily: SERIF, fontSize: 26, marginBottom: 26 }}>G</span>
            <h2 style={{ ...h2, color: "#FBF6EE", fontSize: "clamp(30px,4.2vw,54px)", lineHeight: 1.08, margin: "0 auto", maxWidth: "18ch" }}>You don't have to manage this journey alone.</h2>
            <p style={{ fontSize: "clamp(15px,1.4vw,18px)", color: "#C9BEAE", margin: "20px auto 32px", maxWidth: "44ch", lineHeight: 1.6 }}>Friendly, personalized daily support — one message at a time.</p>
            <span onClick={start} style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "#FBF6EE", color: "#2B2722", padding: "16px 32px", borderRadius: 40, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>Start with Grace <span style={{ fontSize: 18 }}>→</span></span>
            <p style={{ fontSize: 12, color: "#8C8377", margin: "48px auto 0", maxWidth: "64ch", lineHeight: 1.6 }}>Grace does not provide medical advice, diagnosis, or treatment, and is not a substitute for professional healthcare. Always consult your provider about your medication and symptoms.</p>
            <div style={{ fontSize: "12.5px", color: "#7E7567", marginTop: 14 }}>© 2026 Grace · Your GLP-1 companion</div>
          </div>
        </Page>
      </div>

      {/* DOT RAIL */}
      <div style={{ position: "absolute", right: "clamp(12px,1.6vw,26px)", top: "50%", transform: "translateY(-50%)", zIndex: 65, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
        {PAGES.map((label, i) => (
          <div key={label} onClick={() => goTo(i)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 9 }}>
            {i === page
              ? <><span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".3px", color: ACCENT, whiteSpace: "nowrap" }}>{label}</span><span style={{ width: 11, height: 11, borderRadius: "50%", background: ACCENT, boxShadow: "0 0 0 4px rgba(197,122,87,.18)" }} /></>
              : <span style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(43,39,34,.22)" }} />}
          </div>
        ))}
      </div>

      {/* PREV / NEXT */}
      <div style={{ position: "absolute", bottom: "clamp(16px,2.4vw,30px)", left: "50%", transform: "translateX(-50%)", zIndex: 65, display: "flex", alignItems: "center", gap: 16, background: "rgba(251,248,242,.78)", backdropFilter: "blur(8px)", border: "1px solid rgba(226,216,200,.8)", borderRadius: 40, padding: "7px 9px", boxShadow: "0 10px 26px -14px rgba(43,39,34,.35)" }}>
        <span onClick={prev} style={{ width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#2B2722", fontSize: 17, background: "#fff", border: "1px solid #ECE2D2", opacity: page === 0 ? 0.35 : 1 }}>↑</span>
        <span style={{ fontSize: "12.5px", fontWeight: 700, letterSpacing: "1.5px", color: "#6F665B", minWidth: 58, textAlign: "center" }}>{pad(page + 1)} / {pad(total)}</span>
        <span onClick={next} style={{ width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#FBF6EE", fontSize: 17, background: "#2B2722", opacity: page === total - 1 ? 0.35 : 1 }}>↓</span>
      </div>
    </div>
  );
};

const GraceAvatar = () => <div style={{ width: 23, height: 23, borderRadius: "50%", background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontFamily: SERIF, fontSize: 12, flexShrink: 0 }}>G</div>;
const GraceBubble = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: "88%" }}><GraceAvatar /><div style={{ background: "#fff", border: "1px solid #EEE4D5", color: "#2B2722", padding: "10px 13px", borderRadius: "17px 17px 17px 5px", fontSize: "13.5px", lineHeight: 1.5 }}>{children}</div></div>
);
const UserBubble = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "flex", justifyContent: "flex-end" }}><div style={{ background: "#ECCDBC", color: "#3A2E26", padding: "10px 13px", borderRadius: "17px 17px 5px 17px", fontSize: "13.5px", lineHeight: 1.5, maxWidth: "82%" }}>{children}</div></div>
);

export default DesktopDeck;
