import { useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Desktop landing — a bright, warm, premium wellness page. Near-white palette
 * (soft warm whites + light cream), terracotta accent, serif display type, and
 * tasteful motion: gentle section reveals on scroll, soft hover lifts on cards
 * and buttons, and a slow floating hero. No dark/heavy backgrounds. Desktop only
 * (the phone keeps its own iMessage hero). Reduced-motion is respected.
 */

const ACCENT = "#C0744F";        // terracotta
const ACCENT_DEEP = "#A75F3D";   // deeper terracotta for text on light
const INK = "#2B2722";           // primary text
const MUTE = "#6F665B";          // muted text
const PAGE = "#FCFAF6";          // bright warm white (base)
const CREAM = "#F6F0E6";         // very light cream (alt sections)
const SAGE = "#6F7E5B";          // wellness sage accent
const SERIF = "'Newsreader',Georgia,serif";

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

const eyebrow = (color = ACCENT_DEEP): CSSProperties => ({ fontSize: "12.5px", fontWeight: 700, letterSpacing: "2.5px", textTransform: "uppercase", color, marginBottom: 18 });
const h2: CSSProperties = { fontFamily: SERIF, fontWeight: 500, fontSize: "clamp(30px,4vw,50px)", lineHeight: 1.08, letterSpacing: "-.6px", color: INK, margin: 0 };
const sectionPad: CSSProperties = { width: "min(1180px,92vw)", marginInline: "auto", padding: "clamp(72px,10vw,128px) 0" };
const CARD_SHADOW = "0 18px 44px -30px rgba(43,39,34,.22)";
const CARD_SHADOW_HOVER = "0 30px 60px -28px rgba(43,39,34,.30)";

const GraceAvatar = ({ s = 24 }: { s?: number }) => <div style={{ width: s, height: s, borderRadius: "50%", background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontFamily: SERIF, fontSize: s * 0.54, flexShrink: 0 }}>G</div>;

/** Gentle entrance on scroll — respects reduced motion. */
const Reveal = ({ children, y = 26, delay = 0, style }: { children: ReactNode; y?: number; delay?: number; style?: CSSProperties }) => {
  const reduce = useReducedMotion();
  if (reduce) return <div style={style}>{children}</div>;
  return (
    <motion.div
      style={style}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
};

const liftHover = { whileHover: { y: -6, boxShadow: CARD_SHADOW_HOVER }, transition: { type: "spring" as const, stiffness: 300, damping: 24 } };
const btnHover = { whileHover: { scale: 1.035, y: -1 }, whileTap: { scale: 0.98 }, transition: { type: "spring" as const, stiffness: 400, damping: 18 } };

const DesktopLanding = () => {
  const navigate = useNavigate();
  const [openFaq, setOpenFaq] = useState(0);
  const start = () => startWithGrace(() => navigate("/onboarding"));

  return (
    <div className="hidden lg:block" style={{ background: PAGE, color: INK, fontFamily: "'Hanken Grotesque',-apple-system,sans-serif", WebkitFontSmoothing: "antialiased", overflowX: "hidden" }}>
      {/* NAV */}
      <header style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(252,250,246,.82)", backdropFilter: "blur(14px)", borderBottom: "1px solid rgba(226,216,200,.55)" }}>
        <nav style={{ width: "min(1180px,92vw)", marginInline: "auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: "16px 0" }}>
          <a href="#top" style={{ display: "flex", alignItems: "center", textDecoration: "none" }}>
            <span style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 500, letterSpacing: "-.3px", color: INK }}>Grace</span>
          </a>
          <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
            {[["How it works", "#how"], ["Features", "#features"], ["Safety", "#safety"], ["Pricing", "#pricing"]].map(([label, href]) => (
              <a key={href} href={href} className="gdeck-navlink" style={{ textDecoration: "none", color: MUTE, fontSize: "14.5px", fontWeight: 500, transition: "color .2s ease" }}>{label}</a>
            ))}
            <motion.span {...btnHover} onClick={start} style={{ display: "inline-flex", alignItems: "center", gap: 7, background: INK, color: "#FBF6EE", padding: "11px 20px", borderRadius: 30, fontSize: "14.5px", fontWeight: 600, cursor: "pointer" }}>Start with Grace</motion.span>
          </div>
        </nav>
      </header>

      {/* HERO */}
      <section id="top" style={{ background: "linear-gradient(180deg,#FFFDFA 0%,#FBF4EA 100%)" }}>
        <div style={{ width: "min(1180px,92vw)", marginInline: "auto", display: "flex", alignItems: "center", gap: "clamp(36px,6vw,80px)", flexWrap: "wrap", padding: "clamp(52px,7vw,96px) 0 clamp(60px,8vw,104px)" }}>
          <Reveal style={{ flex: "1 1 440px", minWidth: 300 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "#fff", border: "1px solid #EFE4D3", color: MUTE, padding: "8px 16px", borderRadius: 30, fontSize: "12.5px", fontWeight: 600, letterSpacing: ".2px", boxShadow: "0 4px 14px -10px rgba(43,39,34,.3)" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: ACCENT }} />For Ozempic · Wegovy · Mounjaro · Zepbound
            </span>
            <h1 style={{ fontFamily: SERIF, fontWeight: 500, fontSize: "clamp(38px,5.4vw,66px)", lineHeight: 1.03, letterSpacing: "-.8px", color: INK, margin: "24px 0 0", maxWidth: "15ch" }}>Your GLP-1 journey, with support that actually feels <em style={{ fontStyle: "italic", color: ACCENT_DEEP }}>personal</em>.</h1>
            <p style={{ fontSize: "clamp(16.5px,1.5vw,19px)", lineHeight: 1.65, color: MUTE, margin: "24px 0 0", maxWidth: "46ch" }}>Grace helps you track meals, protein, reminders, symptoms, and daily progress — with warm support that feels more like a companion than another app.</p>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 34 }}>
              <motion.span {...btnHover} onClick={start} style={{ display: "inline-flex", alignItems: "center", gap: 9, background: INK, color: "#FBF6EE", padding: "16px 28px", borderRadius: 40, fontSize: "15.5px", fontWeight: 600, cursor: "pointer", boxShadow: "0 16px 32px -16px rgba(43,39,34,.5)" }}>Start with Grace <span style={{ fontSize: 17 }}>→</span></motion.span>
              <motion.a whileHover={{ y: -1, backgroundColor: "#FFFFFF" }} href="#how" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: INK, padding: "16px 24px", borderRadius: 40, fontSize: "15.5px", fontWeight: 600, textDecoration: "none", border: "1.5px solid #E0D2BD" }}>See how it works</motion.a>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 34 }}>
              <div style={{ display: "flex" }}>
                <span style={{ width: 34, height: 34, borderRadius: "50%", background: "#ECEFE2", border: "2px solid #FBF4EA" }} />
                <span style={{ width: 34, height: 34, borderRadius: "50%", background: "#F6E2D2", border: "2px solid #FBF4EA", marginLeft: -12 }} />
                <span style={{ width: 34, height: 34, borderRadius: "50%", background: "#EADCC8", border: "2px solid #FBF4EA", marginLeft: -12 }} />
                <span style={{ width: 34, height: 34, borderRadius: "50%", background: ACCENT, border: "2px solid #FBF4EA", marginLeft: -12, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontSize: 12, fontWeight: 700 }}>＋</span>
              </div>
              <span style={{ fontSize: 14, color: MUTE, lineHeight: 1.4, maxWidth: "30ch" }}>Join thousands building daily consistency with Grace.</span>
            </div>
          </Reveal>
          {/* HERO PHONE */}
          <div style={{ flex: "1 1 320px", display: "flex", justifyContent: "center", minWidth: 280 }}>
            <div style={{ position: "relative", width: "min(322px,84vw)", animation: "gdeck-floaty 7s ease-in-out infinite" }}>
              <div style={{ background: "#23201C", borderRadius: 50, padding: 11, boxShadow: "0 50px 90px -38px rgba(43,39,34,.4),0 14px 34px -16px rgba(43,39,34,.22)" }}>
                <div style={{ position: "relative", background: "#FBF8F2", borderRadius: 40, overflow: "hidden", height: 618, display: "flex", flexDirection: "column" }}>
                  <div style={{ position: "absolute", top: 13, left: "50%", transform: "translateX(-50%)", width: 92, height: 27, background: "#23201C", borderRadius: 16, zIndex: 5 }} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "15px 26px 8px", fontSize: 13, fontWeight: 600, color: INK }}><span>9:41</span><span style={{ fontSize: 11 }}>● ▂▄▆</span></div>
                  <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 20px 13px", borderBottom: "1px solid #ECE3D5" }}>
                    <GraceAvatar s={38} />
                    <div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 700, color: INK, letterSpacing: "-.2px" }}>Grace</div><div style={{ fontSize: "11.5px", color: SAGE, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: SAGE }} />Your GLP-1 companion</div></div>
                    <div style={{ color: "#B6AD9F", fontSize: 20, lineHeight: 0 }}>···</div>
                  </div>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 12, padding: "20px 16px" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: "88%" }}><GraceAvatar /><div style={{ background: "#fff", border: "1px solid #EEE4D5", color: INK, padding: "11px 14px", borderRadius: "18px 18px 18px 6px", fontSize: 14, lineHeight: 1.5 }}>Morning 💛 How are you feeling today?</div></div>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}><div style={{ background: "#ECCDBC", color: "#3A2E26", padding: "11px 14px", borderRadius: "18px 18px 6px 18px", fontSize: 14, lineHeight: 1.5, maxWidth: "82%" }}>Pretty good! I had chicken and rice for lunch</div></div>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: "88%" }}><GraceAvatar /><div style={{ background: "#fff", border: "1px solid #EEE4D5", color: INK, padding: "11px 14px", borderRadius: "18px 18px 18px 6px", fontSize: 14, lineHeight: 1.5 }}>Nice — was the chicken grilled or fried? That helps me log it more accurately 💛</div></div>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}><GraceAvatar /><div style={{ background: "#fff", border: "1px solid #EEE4D5", borderRadius: "18px 18px 18px 6px", padding: "14px 16px", display: "flex", gap: 5, alignItems: "center" }}>{[0, 0.2, 0.4].map((d) => <span key={d} style={{ width: 7, height: 7, borderRadius: "50%", background: "#C2B8A8", animation: `gdeck-blink 1.2s infinite ${d}s` }} />)}</div></div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 18px", borderTop: "1px solid #ECE3D5", background: "#FFFDF9" }}><div style={{ flex: 1, background: "#fff", border: "1px solid #E7DDCD", borderRadius: 22, padding: "11px 16px", fontSize: "13.5px", color: "#A89E8F" }}>Message Grace…</div><div style={{ width: 40, height: 40, borderRadius: "50%", background: INK, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontSize: 17 }}>↑</div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PROBLEM */}
      <section style={{ background: CREAM }}>
        <div style={sectionPad}>
          <Reveal style={{ maxWidth: 760 }}>
            <div style={eyebrow()}>The hard part</div>
            <h2 style={{ ...h2, maxWidth: "18ch" }}>GLP-1 works best with daily support. Most people are left figuring it out alone.</h2>
            <p style={{ fontSize: "clamp(16px,1.4vw,18.5px)", lineHeight: 1.7, color: MUTE, margin: "24px 0 0", maxWidth: "50ch" }}>The questions are constant, the routine is new, and there's a lot to keep track of. It's easy to feel overwhelmed — and easier to fall off.</p>
          </Reveal>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 48, maxWidth: 920 }}>
            {worries.map((w, i) => (
              <motion.div key={w} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.5, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }} whileHover={{ y: -3, backgroundColor: "#FFFFFF" }} style={{ background: "#FFFDF9", border: "1px solid #EBDFCC", borderRadius: 40, padding: "15px 24px", fontFamily: SERIF, fontStyle: "italic", fontSize: "clamp(16px,1.5vw,19px)", color: "#4A4339", boxShadow: "0 2px 8px -4px rgba(43,39,34,.1)" }}>“{w}”</motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* SOLUTION */}
      <section style={{ background: PAGE }}>
        <div style={sectionPad}>
          <Reveal style={{ maxWidth: 720 }}>
            <div style={eyebrow()}>Meet Grace</div>
            <h2 style={{ ...h2, maxWidth: "16ch" }}>Your simple daily companion.</h2>
            <p style={{ fontSize: "clamp(16px,1.4vw,18.5px)", lineHeight: 1.7, color: MUTE, margin: "24px 0 0", maxWidth: "54ch" }}>Grace checks in, remembers your preferences, helps you log meals, tracks your protein, supports your routine, and sends gentle reminders — all through a friendly conversation.</p>
          </Reveal>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(290px,1fr))", gap: "0 clamp(28px,5vw,72px)", marginTop: 54 }}>
            {capabilities.map((c, i) => (
              <motion.div key={c.num} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-50px" }} transition={{ duration: 0.5, delay: (i % 2) * 0.06, ease: [0.22, 1, 0.36, 1] }} style={{ padding: "26px 2px", borderTop: "1px solid #EAE0D0" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                  <span style={{ fontFamily: SERIF, fontSize: 15, color: ACCENT_DEEP, fontWeight: 500, flexShrink: 0 }}>{c.num}</span>
                  <div><div style={{ fontSize: 19, fontWeight: 600, color: INK, letterSpacing: "-.2px" }}>{c.t}</div><div style={{ fontSize: 15, color: MUTE, lineHeight: 1.55, marginTop: 7 }}>{c.d}</div></div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* WHY DIFFERENT */}
      <section style={{ background: "#F9F4EC" }}>
        <div style={sectionPad}>
          <Reveal>
            <div style={eyebrow()}>Why Grace feels different</div>
            <h2 style={{ ...h2, fontSize: "clamp(30px,4.2vw,54px)", lineHeight: 1.06, letterSpacing: "-.7px", margin: "0 0 52px", maxWidth: "20ch" }}>Not another tracking app. A companion that actually <em style={{ fontStyle: "italic", color: ACCENT_DEEP }}>talks to you</em>.</h2>
          </Reveal>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: "clamp(28px,4vw,56px)" }}>
            <Reveal>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "#A89E8F", marginBottom: 6 }}>What you won't find</div>
              {notThis.map((n) => <div key={n} style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 0", borderBottom: "1px solid #ECE2D2" }}><span style={{ width: 22, height: 22, borderRadius: "50%", border: "1.5px solid #D8CCB8", color: "#B6AD9F", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>×</span><span style={{ fontSize: 17, color: "#8C8377", fontWeight: 500 }}>{n}</span></div>)}
            </Reveal>
            <Reveal delay={0.08}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: ACCENT_DEEP, marginBottom: 6 }}>What you get instead</div>
              {butThis.map((b) => <div key={b} style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 0", borderBottom: "1px solid #ECE2D2" }}><span style={{ width: 22, height: 22, borderRadius: "50%", background: ACCENT, color: "#FBF6EE", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>✓</span><span style={{ fontSize: 17, color: INK, fontWeight: 600 }}>{b}</span></div>)}
            </Reveal>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" style={{ background: CREAM }}>
        <div style={sectionPad}>
          <Reveal style={{ textAlign: "center", maxWidth: 620, margin: "0 auto 56px" }}>
            <div style={eyebrow()}>How it works</div>
            <h2 style={h2}>Three easy steps. That's it.</h2>
          </Reveal>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(270px,1fr))", gap: "clamp(20px,3vw,32px)" }}>
            {steps.map((s, i) => (
              <motion.div key={s.n} initial={{ opacity: 0, y: 22 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.55, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }} {...liftHover} style={{ background: "#FFFDF9", border: "1px solid #EBDFCC", borderRadius: 26, padding: "36px 32px", boxShadow: CARD_SHADOW }}>
                <div style={{ fontFamily: SERIF, fontSize: 48, color: ACCENT_DEEP, lineHeight: 1, fontWeight: 500 }}>{s.n}</div>
                <div style={{ fontSize: 21, fontWeight: 700, margin: "20px 0 11px", color: INK, letterSpacing: "-.3px" }}>{s.t}</div>
                <div style={{ fontSize: "15.5px", color: MUTE, lineHeight: 1.6 }}>{s.d}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* A DAY WITH GRACE */}
      <section id="features" style={{ background: PAGE }}>
        <div style={sectionPad}>
          <Reveal style={{ maxWidth: 640, marginBottom: 56 }}>
            <div style={eyebrow()}>A day with Grace</div>
            <h2 style={{ ...h2, maxWidth: "18ch" }}>Real moments, handled with a single message.</h2>
          </Reveal>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "clamp(24px,3.5vw,44px)" }}>
            {mockups.map((m, idx) => (
              <motion.div key={m.caption} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.55, delay: idx * 0.08, ease: [0.22, 1, 0.36, 1] }} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: MUTE, lineHeight: 1.45, minHeight: 42 }}>{m.caption}</div>
                <motion.div whileHover={{ y: -6 }} transition={{ type: "spring", stiffness: 300, damping: 24 }} style={{ background: "#23201C", borderRadius: 38, padding: 9, boxShadow: "0 30px 60px -38px rgba(43,39,34,.4)" }}>
                  <div style={{ background: "#FBF8F2", borderRadius: 30, overflow: "hidden", height: 430, display: "flex", flexDirection: "column" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "16px 16px 12px", borderBottom: "1px solid #ECE3D5" }}>
                      <GraceAvatar s={30} />
                      <div style={{ flex: 1 }}><div style={{ fontSize: "13.5px", fontWeight: 700, color: INK }}>Grace</div><div style={{ fontSize: "10.5px", color: SAGE, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: SAGE }} />online</div></div>
                    </div>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 10, padding: "16px 13px" }}>
                      {m.messages.map((msg, i) => msg.isGrace
                        ? <div key={i} style={{ display: "flex", gap: 7, alignItems: "flex-end", maxWidth: "92%" }}><GraceAvatar s={22} /><div style={{ background: "#fff", border: "1px solid #EEE4D5", color: INK, padding: "10px 13px", borderRadius: "16px 16px 16px 5px", fontSize: "13.5px", lineHeight: 1.5 }}>{msg.text}</div></div>
                        : <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}><div style={{ background: "#ECCDBC", color: "#3A2E26", padding: "10px 13px", borderRadius: "16px 16px 5px 16px", fontSize: "13.5px", lineHeight: 1.5, maxWidth: "84%" }}>{msg.text}</div></div>)}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 13px 15px", borderTop: "1px solid #ECE3D5", background: "#FFFDF9" }}><div style={{ flex: 1, background: "#fff", border: "1px solid #E7DDCD", borderRadius: 20, padding: "9px 14px", fontSize: "12.5px", color: "#A89E8F" }}>Message Grace…</div><div style={{ width: 34, height: 34, borderRadius: "50%", background: INK, display: "flex", alignItems: "center", justifyContent: "center", color: "#FBF6EE", fontSize: 15, flexShrink: 0 }}>↑</div></div>
                  </div>
                </motion.div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* TRUST & SAFETY */}
      <section id="safety" style={{ background: PAGE }}>
        <div style={{ width: "min(1180px,92vw)", marginInline: "auto", padding: "clamp(48px,7vw,96px) 0" }}>
          <Reveal style={{ background: "linear-gradient(135deg,#F1F4EA 0%,#E9EFDF 100%)", border: "1px solid #DDE5CC", borderRadius: 32, padding: "clamp(36px,5vw,68px)" }}>
            <div style={{ maxWidth: 680, margin: "0 auto", textAlign: "center" }}>
              <div style={eyebrow(SAGE)}>Trust &amp; safety</div>
              <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,46px)", lineHeight: 1.1 }}>Supportive, safe, and built for real life.</h2>
              <p style={{ fontSize: "clamp(16px,1.4vw,18px)", lineHeight: 1.7, color: "#55604A", margin: "22px auto 0", maxWidth: "48ch" }}>Grace is not a doctor and doesn't replace medical advice. For serious or unusual symptoms, please contact a healthcare professional. Grace is here for daily habits, tracking, reminders, and gentle wellness support.</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 18, marginTop: 44, maxWidth: 880, marginInline: "auto" }}>
              {safety.map((sf) => <motion.div key={sf} whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 300, damping: 24 }} style={{ background: "#FFFFFF", border: "1px solid #DFE6D0", borderRadius: 18, padding: 22, display: "flex", gap: 13, alignItems: "flex-start", boxShadow: "0 10px 28px -24px rgba(43,39,34,.3)" }}><span style={{ width: 9, height: 9, borderRadius: "50%", background: SAGE, marginTop: 7, flexShrink: 0 }} /><span style={{ fontSize: 15, color: "#3D4534", lineHeight: 1.55, fontWeight: 500 }}>{sf}</span></motion.div>)}
            </div>
          </Reveal>
        </div>
      </section>

      {/* BENEFITS — bright warm panel (was dark) */}
      <section style={{ background: CREAM }}>
        <div style={sectionPad}>
          <Reveal style={{ background: "linear-gradient(135deg,#FDF4EA 0%,#FAEAD9 100%)", border: "1px solid #F1DEC9", borderRadius: 34, padding: "clamp(40px,5.5vw,76px)", boxShadow: "0 30px 70px -50px rgba(43,39,34,.3)" }}>
            <div style={{ maxWidth: 640 }}>
              <div style={eyebrow()}>What changes</div>
              <h2 style={{ ...h2, maxWidth: "18ch" }}>Less guessing, less alone, more daily progress.</h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: "4px 40px", marginTop: 44 }}>
              {benefits.map((bn, i) => (
                <motion.div key={bn} initial={{ opacity: 0, x: -10 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, margin: "-40px" }} transition={{ duration: 0.45, delay: (i % 4) * 0.06, ease: [0.22, 1, 0.36, 1] }} style={{ display: "flex", alignItems: "center", gap: 16, padding: "18px 0", borderBottom: "1px solid rgba(167,95,61,.16)" }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: ACCENT, flexShrink: 0 }} /><span style={{ fontSize: "clamp(17px,1.6vw,20px)", color: INK, fontWeight: 500, letterSpacing: "-.2px" }}>{bn}</span></motion.div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section style={{ background: PAGE }}>
        <div style={sectionPad}>
          <Reveal style={{ textAlign: "center", maxWidth: 620, margin: "0 auto 54px" }}>
            <div style={eyebrow()}>In their words</div>
            <h2 style={h2}>People feel the difference.</h2>
          </Reveal>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: "clamp(20px,3vw,32px)" }}>
            {testimonials.map((t, i) => (
              <motion.div key={t.n} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.55, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }} {...liftHover} style={{ background: "#fff", border: "1px solid #EFE3D1", borderRadius: 26, padding: "34px 32px", display: "flex", flexDirection: "column", gap: 22, boxShadow: CARD_SHADOW }}>
                <div style={{ color: ACCENT, fontSize: 14, letterSpacing: 3 }}>★★★★★</div>
                <div style={{ fontFamily: SERIF, fontSize: 21, lineHeight: 1.45, color: INK }}>“{t.q}”</div>
                <div style={{ display: "flex", alignItems: "center", gap: 13, marginTop: "auto" }}><div style={{ width: 44, height: 44, borderRadius: "50%", background: "#ECEFE2", color: SAGE, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 15 }}>{t.initials}</div><div><div style={{ fontWeight: 700, fontSize: 15, color: INK }}>{t.n}</div><div style={{ fontSize: 13, color: "#9B9183", marginTop: 2 }}>{t.meta}</div></div></div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" style={{ background: CREAM }}>
        <div style={sectionPad}>
          <Reveal style={{ textAlign: "center", maxWidth: 620, margin: "0 auto 54px" }}>
            <div style={eyebrow()}>Get started</div>
            <h2 style={{ ...h2, fontSize: "clamp(30px,4vw,52px)", lineHeight: 1.06, letterSpacing: "-.7px" }}>Start your GLP-1 journey with support that feels personal.</h2>
          </Reveal>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 24, maxWidth: 760, margin: "0 auto", alignItems: "stretch" }}>
            <motion.div initial={{ opacity: 0, y: 22 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }} {...liftHover} style={{ background: "#FFFDF9", border: "1px solid #EBDFCC", borderRadius: 28, padding: "38px 34px", display: "flex", flexDirection: "column", boxShadow: CARD_SHADOW }}>
              <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#9B9183" }}>Free Trial</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "18px 0 4px" }}><span style={{ fontFamily: SERIF, fontSize: 52, fontWeight: 500, color: INK, lineHeight: 1 }}>$0</span><span style={{ fontSize: 14, color: "#9B9183" }}>for 7 days</span></div>
              <div style={{ fontSize: 15, color: MUTE, lineHeight: 1.55, marginBottom: 26 }}>Experience daily support with Grace, free.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 13, marginBottom: 30 }}>
                {freeFeats.map((f) => <div key={f} style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 15, color: "#4A4339" }}><span style={{ width: 20, height: 20, borderRadius: "50%", background: "#EFE3D1", color: "#8C8377", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0 }}>✓</span>{f}</div>)}
              </div>
              <motion.span {...btnHover} onClick={start} style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 15, borderRadius: 36, border: "1.5px solid #2B2722", color: INK, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Start free</motion.span>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 22 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.55, delay: 0.08, ease: [0.22, 1, 0.36, 1] }} whileHover={{ y: -6, boxShadow: "0 36px 70px -34px rgba(192,116,79,.4)" }} style={{ position: "relative", background: "#FFFFFF", border: `2px solid ${ACCENT}`, borderRadius: 28, padding: "38px 34px", display: "flex", flexDirection: "column", boxShadow: "0 28px 60px -34px rgba(192,116,79,.34)" }}>
              <div style={{ position: "absolute", top: 22, right: 24, background: ACCENT, color: "#FBF6EE", fontSize: 11, fontWeight: 700, letterSpacing: ".8px", textTransform: "uppercase", padding: "6px 12px", borderRadius: 20 }}>Most loved</div>
              <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: ACCENT_DEEP }}>Pro</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "18px 0 4px" }}><span style={{ fontFamily: SERIF, fontSize: 52, fontWeight: 500, color: INK, lineHeight: 1 }}>$15</span><span style={{ fontSize: 14, color: "#9B9183" }}>per month</span></div>
              <div style={{ fontSize: 15, color: MUTE, lineHeight: 1.55, marginBottom: 26 }}>Your everyday companion, always there.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 13, marginBottom: 30 }}>
                {proFeats.map((f) => <div key={f} style={{ display: "flex", alignItems: "center", gap: 11, fontSize: 15, color: "#4A4339" }}><span style={{ width: 20, height: 20, borderRadius: "50%", background: ACCENT, color: "#FBF6EE", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0 }}>✓</span>{f}</div>)}
              </div>
              <motion.span {...btnHover} onClick={start} style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 15, borderRadius: 36, background: INK, color: "#FBF6EE", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Start with Grace →</motion.span>
            </motion.div>
          </div>
          <p style={{ textAlign: "center", fontSize: 13, color: "#9B9183", margin: "30px auto 0", maxWidth: "48ch", lineHeight: 1.6 }}>Grace is a wellness companion, not a medical device or healthcare provider. Cancel anytime.</p>
        </div>
      </section>

      {/* FAQ */}
      <section style={{ background: PAGE }}>
        <div style={{ width: "min(820px,92vw)", marginInline: "auto", padding: "clamp(72px,10vw,128px) 0" }}>
          <Reveal style={{ textAlign: "center", marginBottom: 48 }}>
            <div style={eyebrow()}>Good to know</div>
            <h2 style={h2}>Questions, answered simply.</h2>
          </Reveal>
          <div style={{ borderBottom: "1px solid #EAE0D0" }}>
            {FAQ.map((f, i) => (
              <div key={f.q} style={{ borderTop: "1px solid #EAE0D0" }}>
                <div onClick={() => setOpenFaq((o) => (o === i ? -1 : i))} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 24, padding: "24px 4px", cursor: "pointer" }}><span style={{ fontSize: "clamp(16.5px,1.6vw,19px)", fontWeight: 600, color: INK, letterSpacing: "-.2px" }}>{f.q}</span><span style={{ fontFamily: SERIF, fontSize: 28, color: ACCENT_DEEP, lineHeight: 1, flexShrink: 0, width: 24, textAlign: "center", transition: "transform .25s ease", transform: openFaq === i ? "rotate(180deg)" : "none" }}>{openFaq === i ? "–" : "+"}</span></div>
                <motion.div initial={false} animate={{ height: openFaq === i ? "auto" : 0, opacity: openFaq === i ? 1 : 0 }} transition={{ duration: 0.3, ease: "easeInOut" }} style={{ overflow: "hidden" }}>
                  <div style={{ padding: "0 4px 26px", maxWidth: "62ch", fontSize: 16, color: MUTE, lineHeight: 1.7 }}>{f.a}</div>
                </motion.div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CTA BANNER — bright warm (was dark) */}
      <section style={{ background: PAGE }}>
        <div style={{ width: "min(1180px,92vw)", marginInline: "auto", padding: "0 0 clamp(72px,10vw,120px)" }}>
          <Reveal style={{ background: "linear-gradient(135deg,#FBF1E6 0%,#F6E4D2 100%)", border: "1px solid #F0DAC2", borderRadius: 34, padding: "clamp(44px,6vw,84px)", textAlign: "center", boxShadow: "0 40px 90px -60px rgba(167,95,61,.4)" }}>
            <h2 style={{ ...h2, fontSize: "clamp(28px,3.6vw,46px)", lineHeight: 1.1, color: INK, margin: "0 auto", maxWidth: "20ch" }}>You don't have to manage this journey alone.</h2>
            <p style={{ fontSize: "clamp(15px,1.4vw,18px)", color: MUTE, margin: "20px auto 32px", maxWidth: "44ch", lineHeight: 1.65 }}>Friendly, personalized daily support — one message at a time.</p>
            <motion.span {...btnHover} onClick={start} style={{ display: "inline-flex", alignItems: "center", gap: 9, background: INK, color: "#FBF6EE", padding: "16px 32px", borderRadius: 40, fontSize: 16, fontWeight: 700, cursor: "pointer", boxShadow: "0 18px 38px -18px rgba(43,39,34,.5)" }}>Start with Grace <span style={{ fontSize: 18 }}>→</span></motion.span>
          </Reveal>
        </div>
      </section>

      {/* FOOTER — light (was dark) */}
      <footer style={{ background: CREAM, color: MUTE, borderTop: "1px solid #EAE0D0" }}>
        <div style={{ width: "min(1180px,92vw)", marginInline: "auto", padding: "clamp(48px,6vw,72px) 0 40px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 40, justifyContent: "space-between" }}>
            <div style={{ maxWidth: 320 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ fontFamily: SERIF, fontSize: 24, color: INK }}>Grace</span>
              </div>
              <p style={{ fontSize: "14.5px", lineHeight: 1.65, margin: "18px 0 0", color: MUTE }}>Your personal GLP-1 companion — helping you stay consistent, feel supported, and make daily progress without doing it alone.</p>
            </div>
            <div style={{ display: "flex", gap: "clamp(36px,6vw,72px)", flexWrap: "wrap" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "#A89E8F" }}>Product</div>
                <a href="#how" className="gdeck-navlink" style={{ textDecoration: "none", color: MUTE, fontSize: "14.5px", transition: "color .2s ease" }}>How it works</a>
                <a href="#features" className="gdeck-navlink" style={{ textDecoration: "none", color: MUTE, fontSize: "14.5px", transition: "color .2s ease" }}>Features</a>
                <a href="#pricing" className="gdeck-navlink" style={{ textDecoration: "none", color: MUTE, fontSize: "14.5px", transition: "color .2s ease" }}>Pricing</a>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "#A89E8F" }}>Company</div>
                <a href="#safety" className="gdeck-navlink" style={{ textDecoration: "none", color: MUTE, fontSize: "14.5px", transition: "color .2s ease" }}>Safety</a>
                <Link to="/privacy" className="gdeck-navlink" style={{ textDecoration: "none", color: MUTE, fontSize: "14.5px", transition: "color .2s ease" }}>Privacy</Link>
                <Link to="/terms" className="gdeck-navlink" style={{ textDecoration: "none", color: MUTE, fontSize: "14.5px", transition: "color .2s ease" }}>Terms</Link>
              </div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #EAE0D0", marginTop: 48, paddingTop: 26, display: "flex", flexWrap: "wrap", gap: 14, justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#9B9183", lineHeight: 1.6, maxWidth: "62ch" }}>Grace does not provide medical advice, diagnosis, or treatment, and is not a substitute for professional healthcare. Always consult your provider about your medication and symptoms.</span>
            <span style={{ fontSize: 13, color: "#A89E8F" }}>© 2026 Grace</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default DesktopLanding;
