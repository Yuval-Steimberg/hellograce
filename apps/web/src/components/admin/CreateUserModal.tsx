import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onClose: () => void;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MEDICATIONS = ['Ozempic', 'Wegovy', 'Mounjaro', 'Zepbound', 'Compounded semaglutide', 'Compounded tirzepatide', 'Other'];

export default function CreateUserModal({ open, onClose }: Props) {
  const qc = useQueryClient();

  const [form, setForm] = useState({
    firstName: '',
    phone: '',
    medication: '',
    injectionDay: '',
    wakeTime: '07:00',
    sleepTime: '22:00',
    timezone: 'America/New_York',
    goals: '',
    foodDislikes: '',
    currentWeight: '',
    goalWeight: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: () =>
      api.onboard({
        firstName: form.firstName,
        phone: form.phone,
        medication: form.medication,
        injectionDay: form.injectionDay || null,
        wakeTime: form.wakeTime,
        sleepTime: form.sleepTime,
        timezone: form.timezone,
        goals: form.goals ? form.goals.split(',').map((s) => s.trim()).filter(Boolean) : [],
        foodDislikes: form.foodDislikes || null,
        currentWeight: form.currentWeight ? Number(form.currentWeight) : null,
        goalWeight: form.goalWeight ? Number(form.goalWeight) : null,
      }),
    onSuccess: (data) => {
      toast.success(`User ${data.phone} created`);
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
      setForm({
        firstName: '', phone: '', medication: '', injectionDay: '',
        wakeTime: '07:00', sleepTime: '22:00', timezone: 'America/New_York',
        goals: '', foodDislikes: '', currentWeight: '', goalWeight: '',
      });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create user'),
  });

  function validate() {
    const errs: Record<string, string> = {};
    if (!form.firstName.trim()) errs.firstName = 'Required';
    if (!form.phone.trim()) errs.phone = 'Required';
    if (!form.medication.trim()) errs.medication = 'Required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validate()) mutation.mutate();
  }

  const field = (id: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm({ ...form, [id]: e.target.value });
    if (errors[id]) setErrors({ ...errors, [id]: '' });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add new user</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          {/* Required */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="firstName">First name <span className="text-destructive">*</span></Label>
              <Input id="firstName" value={form.firstName} onChange={field('firstName')} placeholder="Alex" />
              {errors.firstName && <p className="text-xs text-destructive">{errors.firstName}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="phone">Phone (E.164) <span className="text-destructive">*</span></Label>
              <Input id="phone" value={form.phone} onChange={field('phone')} placeholder="+15551234567" />
              {errors.phone && <p className="text-xs text-destructive">{errors.phone}</p>}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="medication">Medication <span className="text-destructive">*</span></Label>
            <select
              id="medication"
              value={form.medication}
              onChange={field('medication')}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Select medication…</option>
              {MEDICATIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {errors.medication && <p className="text-xs text-destructive">{errors.medication}</p>}
          </div>

          {/* Scheduling */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="injectionDay">Injection day</Label>
              <select
                id="injectionDay"
                value={form.injectionDay}
                onChange={field('injectionDay')}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">None / unknown</option>
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="timezone">Timezone</Label>
              <Input id="timezone" value={form.timezone} onChange={field('timezone')} placeholder="America/New_York" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wakeTime">Wake time</Label>
              <Input id="wakeTime" type="time" value={form.wakeTime} onChange={field('wakeTime')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sleepTime">Sleep time</Label>
              <Input id="sleepTime" type="time" value={form.sleepTime} onChange={field('sleepTime')} />
            </div>
          </div>

          {/* Weight */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="currentWeight">Current weight (lbs)</Label>
              <Input id="currentWeight" type="number" value={form.currentWeight} onChange={field('currentWeight')} placeholder="210" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="goalWeight">Goal weight (lbs)</Label>
              <Input id="goalWeight" type="number" value={form.goalWeight} onChange={field('goalWeight')} placeholder="180" />
            </div>
          </div>

          {/* Goals & dislikes */}
          <div className="space-y-1">
            <Label htmlFor="goals">Goals (comma-separated)</Label>
            <Input id="goals" value={form.goals} onChange={field('goals')} placeholder="Losing weight, Eating enough protein" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="foodDislikes">Food dislikes (comma-separated)</Label>
            <Input id="foodDislikes" value={form.foodDislikes} onChange={field('foodDislikes')} placeholder="broccoli, mushrooms" />
          </div>

          <p className="text-xs text-muted-foreground">
            A welcome WhatsApp will be sent immediately if Twilio is configured.
            The 3-day trial starts now.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating…' : 'Create user'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
