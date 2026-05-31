# GLP-1 User Question Taxonomy

The canonical map of every question shape Grace must handle. Each subcategory
references its expected intent, expected tool calls, and safety level.

Edit this file when a new question shape is discovered. Then add the
corresponding entries to `services/api/coverage/intents.json`.

---

## 1. Medication

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Dose timing (when to inject / take pill) | `medication_question` | knowledge_search | informational |
| Missed dose | `knowledge` / FAQ cache | knowledge_search | informational |
| Dose change request | `medication_question` | — (warm clinical redirect) | clinical_redirect |
| Dose escalation expectations | `medication_question` / `knowledge` | knowledge_search | informational |
| Storage (fridge / room temp / heat / cold) | `medication_question` | knowledge_search | informational |
| Travel (TSA / flights / time zones) | `medication_question` | FAQ cache | informational |
| Switching medications (Ozempic ↔ Mounjaro etc.) | `medication_question` | — (warm clinical redirect) | clinical_redirect |
| Refill / pricing / pharmacy | `medication_question` | — | informational |
| Injection site choice | `medication_question` | FAQ cache | informational |
| Injection site rotation | `medication_question` | FAQ cache | informational |
| Pen mechanics (priming / cap / needle) | `medication_question` | knowledge_search | informational |
| Compounded vs brand-name | `medication_question` | knowledge_search | informational |

## 2. Side Effects

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Nausea | `knowledge` | FAQ cache | informational |
| Vomiting (single / recurrent) | `knowledge` | knowledge_search | informational → clinical_redirect if persistent |
| Constipation | `knowledge` | FAQ cache | informational |
| Diarrhea | `knowledge` | FAQ cache | informational |
| Bloating | `knowledge` | FAQ cache | informational |
| Heartburn / reflux | `knowledge` | FAQ cache | informational |
| Fatigue | `knowledge` | FAQ cache | informational |
| Hair loss / shedding | `knowledge` | FAQ cache | informational |
| Headache | `knowledge` | knowledge_search | informational |
| Dizziness / lightheadedness | `knowledge` | knowledge_search | informational → clinical_redirect if severe |
| Heart palpitations / racing | `knowledge` | knowledge_search | clinical_redirect |
| Injection site reaction (redness / itch / firmness) | `knowledge` | knowledge_search | informational |
| Severe abdominal pain | `knowledge` | — | emergency |
| Allergic reaction / anaphylaxis signs | `knowledge` | — | emergency |
| Gallbladder symptoms | `knowledge` | — | clinical_redirect |
| Pancreatitis concerns | `knowledge` | — | clinical_redirect |
| Vision changes | `knowledge` | — | clinical_redirect |
| Mood changes | `emotional` / `knowledge` | knowledge_search | clinical_redirect if severe |

## 3. Weight Loss

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| "Why am I not losing?" | `knowledge` | FAQ cache (plateau) | informational |
| "Why did I gain weight?" | `knowledge` | get_weight_trend | informational |
| "Am I losing too fast?" | `knowledge` | get_weight_trend | informational → clinical_redirect if very rapid |
| "Am I losing too slowly?" | `knowledge` | get_weight_trend | informational |
| Plateau identification | `knowledge` | FAQ cache | informational |
| Expected loss rate | `knowledge` | FAQ cache | informational |
| Water-weight fluctuation | `knowledge` | knowledge_search | informational |
| Scale frequency / when to weigh | `knowledge` | — | informational |
| Body composition (fat vs muscle) | `knowledge` | knowledge_search | informational |
| Loose skin | `knowledge` | knowledge_search | informational |

## 4. Food

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Food log (past tense) | `food_log` | log_food | informational |
| Food log continuation ("one scoop", "with milk") | `food_log` | log_food | informational |
| Food removal / correction | `food_question` (FOOD_REMOVAL) | remove_food | informational |
| Meal recommendations | `food_question` | search_food_ideas | informational |
| Specific food protein lookup ("how much protein in X") | `food_question` | knowledge_search | informational |
| "Can I eat X?" (specific dish) | `food_question` | knowledge_search | informational |
| Fast food / restaurant choice | `food_question` | search_food_ideas | informational |
| Dietary restriction adaptation (vegan / vegetarian / kosher / halal) | `food_question` | search_food_ideas | informational |
| Photo-based meal analysis | (image) → `food_log` | log_food | informational |
| Meal timing | `food_question` | knowledge_search | informational |

## 5. Progress Tracking

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Today's protein total | `food_question` (FOOD_SUMMARY) | get_food_summary | informational |
| Today's calorie total | `food_question` (FOOD_SUMMARY) | get_food_summary | informational |
| Protein left today | `food_question` (FOOD_SUMMARY) | get_food_summary | informational |
| Protein breakdown ("how did I reach X") | `food_question` (FOOD_SUMMARY) | get_food_summary | informational |
| Past-day protein ("yesterday's") | `food_question` (FOOD_HISTORY) | get_protein_history | informational |
| Weekly protein average | `food_question` (FOOD_HISTORY) | get_protein_history | informational |
| Protein target explanation | `food_question` (PROTEIN_TARGET) | get_user_profile | informational |
| Weight trend | `knowledge` | get_weight_trend | informational |
| Distance from goal weight | `knowledge` | get_user_profile, get_weight_trend | informational |
| Conditional planning ("if I eat X will I hit goal") | `food_question` (FOOD_SUMMARY) | get_food_summary | informational |

## 6. Emotional Support

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Frustration | `emotional` | — | informational |
| Discouragement | `emotional` | — | informational |
| Want to quit / give up | `emotional` | — | informational |
| Body image distress | `emotional` | — | informational → clinical_redirect if severe |
| Loneliness | `emotional` | — | informational |
| Guilt (binge / cheating myth) | `emotional` | FAQ cache | informational |
| Anxiety about progress | `emotional` | — | informational |
| Fear of regaining weight | `emotional` | — | informational |
| Loss of food-noise identity | `emotional` | FAQ cache | informational |
| Relationship dynamics around weight loss | `emotional` | FAQ cache | informational |
| Crisis / self-harm / suicide ideation | (any) | — | emergency |
| Depression | `emotional` | — | clinical_redirect |

## 7. Exercise

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Logging a workout | `exercise_log` | (future: log_exercise) | informational |
| Best workouts for muscle preservation | `knowledge` | knowledge_search | informational |
| Workout timing around injection | `knowledge` / FAQ | FAQ cache (exercise_during_nausea) | informational |
| Walking step targets | `knowledge` | — | informational |
| Cardio vs resistance | `knowledge` | knowledge_search | informational |
| Protein timing around training | `knowledge` | knowledge_search | informational |
| Exercising while nauseous | `knowledge` / FAQ | FAQ cache | informational |
| Recovery / DOMS | `knowledge` | knowledge_search | informational |

## 8. Social Situations

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Restaurant / eating out | `social_situation` | — | informational |
| Wedding / event | `social_situation` | — | informational |
| Travel meals | `social_situation` | — | informational |
| Holiday meals (Thanksgiving / Christmas / Eid / Passover) | `social_situation` | — | informational |
| Family pressure | `social_situation` | — | informational |
| Partner/family doesn't know about GLP-1 | `social_situation` | — | informational |
| Alcohol / social drinking | `knowledge` / FAQ | FAQ cache (alcohol_expanded) | informational |
| Hangover recovery | `knowledge` / FAQ | FAQ cache (hangover_recovery) | informational |

## 9. Safety

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Drug interaction | `medication_question` | — (warm clinical redirect) | clinical_redirect |
| Pregnancy on GLP-1 | `medication_question` | FAQ cache (pregnancy_redirect) | clinical_redirect |
| Breastfeeding | `medication_question` | FAQ cache | clinical_redirect |
| Dosing error (took too much / double dose) | (any) | FAQ cache (dose_error) | clinical_redirect |
| Severe abdominal pain | (any) | — | emergency |
| Persistent vomiting >24h | (any) | — | clinical_redirect |
| Allergic reaction signs | (any) | — | emergency |
| Suicide / self-harm | (any) | — | emergency (safety guard) |
| Chest pain / breathing trouble | (any) | — | emergency (safety guard) |
| Fainting / loss of consciousness | (any) | — | emergency |

## 10. Motivation & Adherence

| Subcategory | Expected intent | Expected tools | Safety level |
|---|---|---|---|
| Forgot injection / missed dose | `medication_question` / FAQ | FAQ cache (dose_error) | informational |
| Want to stop taking medication | `emotional` / `medication_question` | — (warm clinical redirect for "stopping") | clinical_redirect |
| Tired of injecting | `emotional` | — | informational |
| Cost concerns | `medication_question` | — | informational |
| Refill running out | `medication_question` | — | informational |
| Loss of motivation | `emotional` | — | informational |
| Restarting after quitting | `emotional` | — | informational |

---

## Journey Stages

Cross-cuts all 10 domains. See `services/api/coverage/journey-map.json` for
stage-specific tone notes and high-frequency questions per stage.

1. Considering medication
2. First week
3. Ramp-up (dose escalation)
4. Active weight loss (months 1-12)
5. Plateau
6. Approaching goal weight
7. Goal weight reached
8. Maintenance
9. Coming off (tapering)
10. Restarted after quitting
11. Diabetic-primary (vs weight-loss-primary)

---

## Phrasing Styles

Cross-cuts every domain. Coverage generator must produce variants in each:

- **Short (1-3 words)**: "nausea", "help", "tired", "pause"
- **Long (multi-paragraph)**: detailed life-context messages
- **Multi-question**: "Why am I tired and should I increase my dose?"
- **Emotional + factual mix**: feeling + concrete question
- **Slang / informal**: "rn", "literally", "ngl", "tho", "imo"
- **Typo-laden**: realistic misspellings
- **Follow-ups**: "What do you mean?", "Like what?"
- **Corrections**: "Actually it was 3 not 2"
- **Hedged questions**: "I might be wrong but…", "Is this a stupid Q…"
- **Direct commands**: "Log it", "Skip it", "Stop"
