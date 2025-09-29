// lib/supabase.js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  'https://pebuctrvjlhylbrvwvhw.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlYnVjdHJ2amxoeWxicnZ3dmh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODEwMTUsImV4cCI6MjA3NDA1NzAxNX0.X7sWrDlhx3XGMo-RZgI9AVjF19Ts9uUoEAfuLBHqra8'  // Get from Supabase dashboard
)