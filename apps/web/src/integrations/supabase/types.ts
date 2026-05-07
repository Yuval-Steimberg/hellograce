export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      check_ins: {
        Row: {
          created_at: string
          id: string
          message_sent: string
          mood_score: number | null
          protein_logged: string | null
          slot_index: number | null
          type: string
          user_id: string
          user_reply: string | null
          water_logged: boolean | null
        }
        Insert: {
          created_at?: string
          id?: string
          message_sent: string
          mood_score?: number | null
          protein_logged?: string | null
          slot_index?: number | null
          type: string
          user_id: string
          user_reply?: string | null
          water_logged?: boolean | null
        }
        Update: {
          created_at?: string
          id?: string
          message_sent?: string
          mood_score?: number | null
          protein_logged?: string | null
          slot_index?: number | null
          type?: string
          user_id?: string
          user_reply?: string | null
          water_logged?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "check_ins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      grace_knowledge: {
        Row: {
          embedding: string | null
          grace_response: string
          id: string
          style_tag: string | null
          topic: string | null
          user_message: string
        }
        Insert: {
          embedding?: string | null
          grace_response: string
          id?: string
          style_tag?: string | null
          topic?: string | null
          user_message: string
        }
        Update: {
          embedding?: string | null
          grace_response?: string
          id?: string
          style_tag?: string | null
          topic?: string | null
          user_message?: string
        }
        Relationships: []
      }
      injections: {
        Row: {
          confirmed_at: string | null
          created_at: string
          id: string
          injection_date: string
          side_effects_reported: string | null
          user_id: string
        }
        Insert: {
          confirmed_at?: string | null
          created_at?: string
          id?: string
          injection_date?: string
          side_effects_reported?: string | null
          user_id: string
        }
        Update: {
          confirmed_at?: string | null
          created_at?: string
          id?: string
          injection_date?: string
          side_effects_reported?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "injections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          active: boolean
          auth_user_id: string | null
          blocked: boolean
          checkin_count_per_day: number | null
          checkin_days_interval: number | null
          checkin_frequency: string
          consecutive_no_reply_days: number
          created_at: string
          current_weight: number | null
          dose_change_started_at: string | null
          email: string | null
          first_name: string
          food_dislikes: string | null
          goal_weight: number | null
          goals: string[] | null
          grace_notes: string | null
          hydration_struggle: boolean
          id: string
          injection_count: number
          injection_day: string
          injection_day_2: string | null
          injection_done_at: string | null
          injection_evening_followup_due: boolean
          injection_flow_stage: string | null
          injection_flow_started_at: string | null
          injection_side_effect_free: boolean
          is_paid: boolean
          is_pro: boolean
          last_checkin_mode: string | null
          last_evening_sent_at: string | null
          last_midday_sent_at: string | null
          last_milestone_sent_at: string | null
          last_morning_sent_at: string | null
          last_reply_at: string | null
          low_mood_mode: boolean
          medication: string
          medication_frequency: string | null
          medication_time: string | null
          messages_sent_today: number
          messages_sent_today_date: string | null
          midday_skip: boolean
          paused: boolean
          paused_at: string | null
          phone: string
          pill_time: string | null
          protein_focus_boost: boolean
          safety_flag: string | null
          safety_flagged_at: string | null
          safety_pause_until: string | null
          side_effect_flow: string | null
          side_effect_flow_started_at: string | null
          side_effect_followup_sent: boolean
          sleep_time: string
          timezone: string
          trial_start: string
          updated_at: string
          wake_time: string
          week_number: number | null
        }
        Insert: {
          active?: boolean
          auth_user_id?: string | null
          blocked?: boolean
          checkin_count_per_day?: number | null
          checkin_days_interval?: number | null
          checkin_frequency?: string
          consecutive_no_reply_days?: number
          created_at?: string
          current_weight?: number | null
          dose_change_started_at?: string | null
          email?: string | null
          first_name: string
          food_dislikes?: string | null
          goal_weight?: number | null
          goals?: string[] | null
          grace_notes?: string | null
          hydration_struggle?: boolean
          id?: string
          injection_count?: number
          injection_day: string
          injection_day_2?: string | null
          injection_done_at?: string | null
          injection_evening_followup_due?: boolean
          injection_flow_stage?: string | null
          injection_flow_started_at?: string | null
          injection_side_effect_free?: boolean
          is_paid?: boolean
          is_pro?: boolean
          last_checkin_mode?: string | null
          last_evening_sent_at?: string | null
          last_midday_sent_at?: string | null
          last_milestone_sent_at?: string | null
          last_morning_sent_at?: string | null
          last_reply_at?: string | null
          low_mood_mode?: boolean
          medication: string
          medication_frequency?: string | null
          medication_time?: string | null
          messages_sent_today?: number
          messages_sent_today_date?: string | null
          midday_skip?: boolean
          paused?: boolean
          paused_at?: string | null
          phone: string
          pill_time?: string | null
          protein_focus_boost?: boolean
          safety_flag?: string | null
          safety_flagged_at?: string | null
          safety_pause_until?: string | null
          side_effect_flow?: string | null
          side_effect_flow_started_at?: string | null
          side_effect_followup_sent?: boolean
          sleep_time?: string
          timezone?: string
          trial_start?: string
          updated_at?: string
          wake_time?: string
          week_number?: number | null
        }
        Update: {
          active?: boolean
          auth_user_id?: string | null
          blocked?: boolean
          checkin_count_per_day?: number | null
          checkin_days_interval?: number | null
          checkin_frequency?: string
          consecutive_no_reply_days?: number
          created_at?: string
          current_weight?: number | null
          dose_change_started_at?: string | null
          email?: string | null
          first_name?: string
          food_dislikes?: string | null
          goal_weight?: number | null
          goals?: string[] | null
          grace_notes?: string | null
          hydration_struggle?: boolean
          id?: string
          injection_count?: number
          injection_day?: string
          injection_day_2?: string | null
          injection_done_at?: string | null
          injection_evening_followup_due?: boolean
          injection_flow_stage?: string | null
          injection_flow_started_at?: string | null
          injection_side_effect_free?: boolean
          is_paid?: boolean
          is_pro?: boolean
          last_checkin_mode?: string | null
          last_evening_sent_at?: string | null
          last_midday_sent_at?: string | null
          last_milestone_sent_at?: string | null
          last_morning_sent_at?: string | null
          last_reply_at?: string | null
          low_mood_mode?: boolean
          medication?: string
          medication_frequency?: string | null
          medication_time?: string | null
          messages_sent_today?: number
          messages_sent_today_date?: string | null
          midday_skip?: boolean
          paused?: boolean
          paused_at?: string | null
          phone?: string
          pill_time?: string | null
          protein_focus_boost?: boolean
          safety_flag?: string | null
          safety_flagged_at?: string | null
          safety_pause_until?: string | null
          side_effect_flow?: string | null
          side_effect_flow_started_at?: string | null
          side_effect_followup_sent?: boolean
          sleep_time?: string
          timezone?: string
          trial_start?: string
          updated_at?: string
          wake_time?: string
          week_number?: number | null
        }
        Relationships: []
      }
      verification_codes: {
        Row: {
          code: string
          created_at: string
          expires_at: string
          id: string
          phone: string
          used: boolean
        }
        Insert: {
          code: string
          created_at?: string
          expires_at?: string
          id?: string
          phone: string
          used?: boolean
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string
          id?: string
          phone?: string
          used?: boolean
        }
        Relationships: []
      }
      weight_logs: {
        Row: {
          id: string
          logged_at: string
          milestone_text: string | null
          user_id: string
          weight: number
        }
        Insert: {
          id?: string
          logged_at?: string
          milestone_text?: string | null
          user_id: string
          weight: number
        }
        Update: {
          id?: string
          logged_at?: string
          milestone_text?: string | null
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "weight_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_grace_knowledge: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          grace_response: string
          similarity: number
          style_tag: string
          user_message: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
