// Keywords that indicate a high-stakes medical query requiring the Pro model.
// All other queries route to Flash for cost + latency efficiency.
const ESCALATION_PATTERNS: RegExp[] = [
  /chest\s*pain|difficulty\s*breath|trouble\s*breath|can'?t\s*breath/i,
  /anaphyla|allergic\s*reaction|throat\s*(clos|swell)/i,
  /pancreatitis|severe\s*abdominal|intense\s*(stomach|belly)\s*pain/i,
  /palpitat|heart\s*(racing|pounding|irregular)/i,
  /suicid|self.?harm|want\s*to\s*die|hurt\s*myself/i,
  /titrat|dose\s*change|dose\s*increase|inject\s*[\d.]+\s*mg|new\s*(dose|dosage)/i,
  /drug\s*interact|safe\s*to\s*take.*with|can\s*i\s*take.*and/i,
  /\bER\b|emergency\s*room|hospital|ambulance|urgent\s*care/i,
  /seizure|faint|pass\s*out|unconscious/i,
  /kidney|liver\s*fail|renal/i,
];

export interface RouterDecision {
  model: string;
  reason: string;
}

export function routeModel(
  userMessage: string,
  flashModel: string,
  proModel: string,
): RouterDecision {
  for (const pattern of ESCALATION_PATTERNS) {
    if (pattern.test(userMessage)) {
      return { model: proModel, reason: `escalation: ${pattern.source.slice(0, 40)}` };
    }
  }
  return { model: flashModel, reason: 'standard' };
}
