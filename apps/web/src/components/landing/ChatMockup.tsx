import { motion } from "framer-motion";

/**
 * WhatsApp-style chat mockup that shows what users actually get from grace.
 * Used in HeroSection to replace abstract imagery with concrete proof of value.
 */
const ChatMockup = () => {
  const messages: { from: "user" | "grace"; text: string; time?: string }[] = [
    {
      from: "user",
      text: "feeling really nauseous after my wegovy shot last night 😩",
      time: "8:14 AM",
    },
    {
      from: "grace",
      text: "Sorry you're feeling rough. Day-after nausea is most intense in the first 24–48h. Try plain crackers + ginger tea, and skip anything fried today. How's your hydration looking?",
      time: "8:14 AM",
    },
    {
      from: "user",
      text: "barely drank anything yesterday",
      time: "8:15 AM",
    },
    {
      from: "grace",
      text: "That's playing a role. Aim for 16oz before lunch — small sips, not chugs. I'll check on you again at 1pm. Also: what's your protein target today?",
      time: "8:15 AM",
    },
    {
      from: "user",
      text: "90g right?",
      time: "8:16 AM",
    },
    {
      from: "grace",
      text: "Yep — for your goal weight, 90g. Two eggs + Greek yogurt = a stress-free 35g start. You've got this. 🤍",
      time: "8:16 AM",
    },
  ];

  return (
    <div className="relative">
      {/* Phone frame */}
      <div className="bg-[#0e1b1d] rounded-[2.5rem] p-3 shadow-2xl shadow-primary/10">
        <div className="bg-[#e6dfd5] rounded-[2rem] overflow-hidden">
          {/* Chat header */}
          <div className="bg-[#075e54] text-white px-5 py-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#f3eee7] flex items-center justify-center">
              <span className="font-serif text-lg text-[#075e54]">g</span>
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">grace</div>
              <div className="text-[11px] text-white/70">online · daily GLP-1 companion</div>
            </div>
          </div>

          {/* Messages */}
          <div
            className="px-3 py-4 space-y-2 min-h-[480px]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 6px)",
            }}
          >
            {messages.map((m, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 8 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ delay: 0.1 + i * 0.08, duration: 0.3 }}
                className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[13px] leading-snug shadow-sm ${
                    m.from === "user"
                      ? "bg-[#d9fdd3] text-[#111b21] rounded-br-sm"
                      : "bg-white text-[#111b21] rounded-bl-sm"
                  }`}
                >
                  <p>{m.text}</p>
                  {m.time && (
                    <span className="block text-[10px] text-[#667781] mt-0.5 text-right">
                      {m.time}
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* Floating accent badge */}
      <div className="absolute -bottom-3 -left-3 sm:-left-5 bg-card border border-sand rounded-full px-4 py-2 shadow-lg shadow-primary/5 flex items-center gap-2">
        <span className="text-accent text-base">✦</span>
        <span className="text-xs font-medium text-foreground">Right in WhatsApp</span>
      </div>
    </div>
  );
};

export default ChatMockup;
