import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AdminUser } from '../../lib/api';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

const PAGE_SIZE = 50;

function statusBadge(user: AdminUser) {
  if (user.blocked) return <Badge variant="destructive">Blocked</Badge>;
  if (user.paused) return <Badge variant="secondary">Paused</Badge>;
  if (!user.active) return <Badge variant="outline">Inactive</Badge>;
  if (user.is_pro) return <Badge className="bg-purple-600">Pro</Badge>;
  if (user.is_paid) return <Badge className="bg-blue-600">Paid</Badge>;
  return <Badge variant="outline" className="text-green-600 border-green-600">Active</Badge>;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

export default function UsersPage() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', page],
    queryFn: () => api.users(PAGE_SIZE, page * PAGE_SIZE),
    placeholderData: (prev) => prev,
  });

  const filtered = (data?.users ?? []).filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.phone.includes(q) ||
      (u.first_name ?? '').toLowerCase().includes(q) ||
      (u.medication ?? '').toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-sm text-muted-foreground">
            {data?.total ?? '—'} total users
          </p>
        </div>
        <Input
          className="w-64"
          placeholder="Search phone, name, or medication…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">User</th>
                <th className="px-4 py-3 text-left font-medium">Medication</th>
                <th className="px-4 py-3 text-left font-medium">Goals</th>
                <th className="px-4 py-3 text-left font-medium">Injection day</th>
                <th className="px-4 py-3 text-left font-medium">Last reply</th>
                <th className="px-4 py-3 text-left font-medium">Joined</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No users found
                  </td>
                </tr>
              )}
              {filtered.map((user) => (
                <tr key={user.phone} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{user.first_name ?? 'Unknown'}</div>
                    <div className="text-xs text-muted-foreground">{user.phone}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {user.medication ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(user.goals ?? []).slice(0, 2).map((g) => (
                        <Badge key={g} variant="outline" className="text-xs">{g}</Badge>
                      ))}
                      {(user.goals ?? []).length > 2 && (
                        <Badge variant="outline" className="text-xs">+{user.goals.length - 2}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {user.injection_day ?? '—'}
                    {user.injection_count > 0 && (
                      <span className="text-xs ml-1">(#{user.injection_count})</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(user.last_reply_at)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(user.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    {statusBadge(user)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
