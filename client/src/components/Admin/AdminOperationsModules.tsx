/* eslint-disable i18next/no-literal-string -- Bangladesh-specific operations modules intentionally mix English labels with Bangla guidance. */
import React, { useCallback, useEffect, useState } from 'react';
import type {
  AdminUserRecord,
  ConsultationDetailResponse,
  ConsultationListItem,
  GovernanceResponse,
  SystemOpsResponse,
} from './types';
import { SeverityBadge } from './AdminCharts';
import { adminFetchJson } from './types';

/* ============================================================================
 * MODULE 6: CONSULTATION & STEP-BY-STEP TRACE INSPECTOR
 * ========================================================================== */
export function ConsultationsTraceInspector({
  token,
  initialConversationId,
}: {
  token?: string;
  initialConversationId?: string;
}) {
  const [items, setItems] = useState<ConsultationListItem[]>([]);
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('all');
  const [selectedId, setSelectedId] = useState<string>(initialConversationId || '');
  const [detail, setDetail] = useState<ConsultationDetailResponse | null>(null);

  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ q: search, severity });
    const res = await adminFetchJson<{ items: ConsultationListItem[] }>(
      `/consultations?${params.toString()}`,
      token,
    );
    setItems(res.items);
    if (!selectedId && res.items[0]) {
      setSelectedId(res.items[0].conversationId);
    }
  }, [search, severity, selectedId, token]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    adminFetchJson<ConsultationDetailResponse>(`/consultations/${selectedId}`, token)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [selectedId, token]);

  const handleDelete = async (cid: string) => {
    await adminFetchJson(`/consultations/${cid}`, token, { method: 'DELETE' });
    setSelectedId('');
    await loadList();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search consultations by symptom, medicine, specialty, or patient email…"
          className="min-w-[260px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-white"
        />
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
        >
          <option value="all">All Severities</option>
          <option value="emergency">🚨 Emergency Red-Flags</option>
          <option value="high">🦟 High / Dengue</option>
          <option value="moderate">🧬 Moderate / PGx / Renal</option>
          <option value="routine">✅ Routine</option>
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="max-h-[650px] space-y-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/90 p-3 lg:col-span-5">
          {items.map((item) => (
            <button
              key={item.conversationId}
              type="button"
              onClick={() => setSelectedId(item.conversationId)}
              className={`w-full rounded-lg border p-3 text-left transition ${
                selectedId === item.conversationId
                  ? 'border-emerald-500/60 bg-emerald-950/30'
                  : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <SeverityBadge severity={item.severity} />
                <span className="font-mono text-[11px] text-slate-400">
                  {item.messagesCount} msgs · {item.toolCalls} tools
                </span>
              </div>
              <div className="mt-2 text-xs font-semibold text-white">{item.title}</div>
              <div className="mt-1 line-clamp-2 text-[11px] text-slate-400">
                {item.firstUserPrompt}
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-cyan-300">
                <span>{item.specialty}</span>
                <span className="text-slate-400">{item.userEmail}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="max-h-[650px] overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/90 p-5 lg:col-span-7">
          {!detail ? (
            <div className="py-16 text-center text-xs text-slate-400">
              Select a patient consultation on the left to inspect its full transcript & tool
              traces.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white">{detail.conversation.title}</h3>
                  <p className="text-xs text-slate-400">
                    Patient: {detail.patient?.name} ({detail.patient?.email}) · Agent:{' '}
                    <span className="font-mono text-emerald-300">
                      {detail.conversation.agent_id}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(detail.conversation.conversationId)}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-500/25"
                >
                  🗑️ Delete Thread
                </button>
              </div>

              {detail.messages.map((m) => (
                <div
                  key={m.messageId}
                  className={`rounded-xl border p-4 text-xs ${
                    m.isCreatedByUser
                      ? 'border-sky-500/30 bg-sky-950/20'
                      : 'border-emerald-500/30 bg-slate-950/90'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between text-[11px]">
                    <span className="font-bold text-white">
                      {m.isCreatedByUser ? '🧑 Patient Prompt' : `🩺 ${m.sender || 'Doctor AI'}`}
                    </span>
                    <span className="font-mono text-slate-400">
                      {m.tokenCount ? `${m.tokenCount} tokens` : ''}
                    </span>
                  </div>

                  {Array.isArray(m.content) &&
                    m.content
                      .filter((part) => part.type === 'tool_call' && part.tool_call)
                      .map((part, idx) => (
                        <div
                          key={`${m.messageId}-tc-${idx}`}
                          className="mb-2.5 rounded-lg border border-violet-500/30 bg-violet-950/20 p-2.5 font-mono text-[11px]"
                        >
                          <div className="font-bold text-violet-300">
                            ⚙️ Tool Call: {part.tool_call?.name}
                          </div>
                          {part.tool_call?.args && (
                            <div className="mt-1 text-cyan-200">Args: {part.tool_call.args}</div>
                          )}
                          {part.tool_call?.output && (
                            <div className="mt-1 line-clamp-4 text-slate-300">
                              Output: {part.tool_call.output}
                            </div>
                          )}
                        </div>
                      ))}

                  <div className="whitespace-pre-wrap leading-relaxed text-slate-200">{m.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * MODULE 7: USERS, DOCTORS, CREDITS & LONGITUDINAL PATIENT MEMORY DIRECTORY
 * ========================================================================== */
export function UsersAndPatientMemoryManager({
  token,
  onMutated,
}: {
  token?: string;
  onMutated?: () => void;
}) {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUserRecord | null>(null);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('USER');
  const [memKey, setMemKey] = useState('father_renal_profile');
  const [memValue, setMemValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const res = await adminFetchJson<{ users: AdminUserRecord[] }>('/users', token);
    setUsers(res.users);
    setSelectedUser((prev) => res.users.find((u) => u.id === prev?.id) || res.users[0] || null);
  }, [token]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;
    await adminFetchJson('/users', token, {
      method: 'POST',
      body: JSON.stringify({
        name: newName,
        email: newEmail,
        password: newPassword,
        role: newRole,
        tokenCredits: 500000,
      }),
    });
    setNewName('');
    setNewEmail('');
    setNewPassword('');
    setMsg(`✅ নতুন অ্যাকাউন্ট তৈরি হয়েছে (${newEmail})`);
    await loadUsers();
    onMutated?.();
  };

  const toggleRole = async (u: AdminUserRecord) => {
    const nextRole = u.role === 'ADMIN' ? 'USER' : 'ADMIN';
    await adminFetchJson(`/users/${u.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ role: nextRole }),
    });
    setMsg(`✅ ${u.email} এর রোল পরিবর্তন করে ${nextRole} করা হয়েছে`);
    await loadUsers();
    onMutated?.();
  };

  const addCredits = async (u: AdminUserRecord) => {
    await adminFetchJson(`/users/${u.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ tokenCredits: u.tokenCredits + 250000 }),
    });
    setMsg(`✅ ${u.email}-কে +250,000 টোকেন ক্রেডিট দেওয়া হয়েছে`);
    await loadUsers();
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser || !memKey.trim() || !memValue.trim()) return;
    await adminFetchJson(`/users/${selectedUser.id}/memories`, token, {
      method: 'POST',
      body: JSON.stringify({ key: memKey, value: memValue }),
    });
    setMemValue('');
    setMsg(`✅ ক্লিনিক্যাল মেমোরি সংরক্ষিত হয়েছে (${memKey})`);
    await loadUsers();
    onMutated?.();
  };

  const handleDeleteMemory = async (uid: string, key: string) => {
    await adminFetchJson(`/users/${uid}/memories/${key}`, token, { method: 'DELETE' });
    await loadUsers();
    onMutated?.();
  };

  return (
    <div className="space-y-5">
      {msg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200">
          {msg}
        </div>
      )}

      {/* Create Doctor / Patient Account */}
      <form
        onSubmit={handleCreateUser}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900/90 p-4"
      >
        <div className="min-w-[180px] flex-1">
          <label className="block text-[11px] text-slate-400">Full Name</label>
          <input
            aria-label="New User Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Dr. Nusrat Jahan"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="block text-[11px] text-slate-400">Email Address *</label>
          <input
            aria-label="New User Email"
            required
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="nusrat.cardiology@medical.ai"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
          />
        </div>
        <div className="min-w-[220px] flex-1">
          <label className="block text-[11px] text-slate-400">Initial Password (12+ chars) *</label>
          <input
            aria-label="New User Initial Password"
            required
            minLength={12}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Set a unique temporary password"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
          />
        </div>
        <div>
          <label className="block text-[11px] text-slate-400">Role</label>
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="mt-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
          >
            <option value="USER">PATIENT / USER</option>
            <option value="ADMIN">HOSPITAL ADMIN</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
        >
          ➕ Create Account
        </button>
      </form>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/90 p-4 lg:col-span-7">
          <h3 className="mb-3 text-sm font-semibold text-white">
            👥 Registered Admins, Clinicians & Patients ({users.length})
          </h3>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 text-slate-400">
              <tr>
                <th className="py-2">User</th>
                <th className="py-2">Role</th>
                <th className="py-2 text-right">Chats</th>
                <th className="py-2 text-right">Credits</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {users.map((u) => (
                <tr
                  key={u.id}
                  onClick={() => setSelectedUser(u)}
                  className={`cursor-pointer ${
                    selectedUser?.id === u.id ? 'bg-emerald-950/30' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <td className="py-2.5">
                    <div className="font-semibold text-white">{u.name}</div>
                    <div className="text-[11px] text-slate-400">{u.email}</div>
                  </td>
                  <td className="py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        u.role === 'ADMIN'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-sky-500/20 text-sky-300'
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono text-slate-300">
                    {u.conversationsCount}
                  </td>
                  <td className="py-2.5 text-right font-mono text-emerald-300">
                    {u.tokenCredits.toLocaleString()}
                  </td>
                  <td
                    className="space-x-1.5 py-2.5 text-right"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => toggleRole(u)}
                      className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] text-slate-200 hover:border-emerald-500"
                    >
                      Switch Role
                    </button>
                    <button
                      type="button"
                      onClick={() => addCredits(u)}
                      className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300"
                    >
                      +250k Credits
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Per-Person Longitudinal Clinical Memory Inspector */}
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/90 p-4 lg:col-span-5">
          <h3 className="text-sm font-semibold text-white">
            🧠 Per-Person Longitudinal Clinical Memory ({selectedUser?.name || 'Select User'})
          </h3>
          <p className="text-[11px] text-slate-400">
            রোগী ও পরিবারের সদস্যদের (Self / Father / Mother) আলাদা অ্যালার্জি, রোগ ও ওষুধের
            প্রোফাইল
          </p>

          <form onSubmit={handleAddMemory} className="space-y-2">
            <input
              value={memKey}
              onChange={(e) => setMemKey(e.target.value)}
              placeholder="Memory key (e.g. self_allergies, father_ckd_meds)"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-cyan-300"
            />
            <textarea
              rows={2}
              value={memValue}
              onChange={(e) => setMemValue(e.target.value)}
              placeholder="e.g. Father (Age 66): CKD Stage 3b (eGFR 38), anaphylactic Penicillin allergy, on Bizoran 5/20"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-xs text-white"
            />
            <button
              type="submit"
              className="w-full rounded-lg bg-cyan-600 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500"
            >
              💾 Save Patient Memory Entry
            </button>
          </form>

          <div className="max-h-72 space-y-2 overflow-y-auto pt-2">
            {selectedUser?.memories.map((m) => (
              <div
                key={m.key}
                className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-cyan-300">{m.key}</span>
                  <button
                    type="button"
                    onClick={() => handleDeleteMemory(selectedUser.id, m.key)}
                    className="text-[11px] text-rose-400 hover:underline"
                  >
                    Delete
                  </button>
                </div>
                <p className="mt-1 text-slate-200">{m.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * MODULE 8: RBAC ROLES, HOSPITAL BROADCAST BANNERS & AUDIT LOGS
 * ========================================================================== */
export function GovernanceRbacAndBanners({
  token,
  onMutated,
}: {
  token?: string;
  onMutated?: () => void;
}) {
  const [data, setData] = useState<GovernanceResponse | null>(null);
  const [bannerText, setBannerText] = useState('');

  const loadGov = useCallback(async () => {
    const res = await adminFetchJson<GovernanceResponse>('/governance', token);
    setData(res);
  }, [token]);

  useEffect(() => {
    loadGov();
  }, [loadGov]);

  const publishBanner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bannerText.trim()) return;
    await adminFetchJson('/governance/banners', token, {
      method: 'POST',
      body: JSON.stringify({ message: bannerText }),
    });
    setBannerText('');
    await loadGov();
    onMutated?.();
  };

  const deleteBanner = async (bannerId: string) => {
    await adminFetchJson(`/governance/banners/${bannerId}`, token, { method: 'DELETE' });
    await loadGov();
    onMutated?.();
  };

  const toggleRolePerm = async (
    roleName: string,
    permissionType: string,
    key: string,
    current: boolean,
  ) => {
    await adminFetchJson(`/governance/roles/${roleName}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ permissionType, key, value: !current }),
    });
    await loadGov();
  };

  return (
    <div className="space-y-5">
      {/* Live Hospital Broadcast Banner */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5">
        <h3 className="text-sm font-bold text-white">
          📢 Live Clinical Broadcast Banner (সকল রোগীর স্ক্রিনে তাৎক্ষণিক জরুরি স্বাস্থ্য বার্তা)
        </h3>
        <form onSubmit={publishBanner} className="mt-3 flex flex-wrap gap-2">
          <input
            aria-label="Broadcast Banner Message"
            value={bannerText}
            onChange={(e) => setBannerText(e.target.value)}
            placeholder="🦟 ডেঙ্গু মৌসুমের সতর্কতা: জ্বর হলে ডাক্তারের পরামর্শ ছাড়া Ibuprofen / Diclofenac / Aspirin খাবেন না।"
            className="min-w-[260px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-white"
          />
          <button
            type="submit"
            className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-500"
          >
            📣 Publish Live Banner
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              setBannerText(
                '🦟 ডেঙ্গু সতর্কতা: জ্বরের সাথে পেটে ব্যথা, বমি বা প্লাটিলেট কমে গেলে অবিলম্বে জরুরি বিভাগে যোগাযোগ করুন — কোনো NSAID ব্যথানাশক খাবেন না।',
              )
            }
            className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-[11px] text-amber-300"
          >
            + Dengue Warning Template
          </button>
          <button
            type="button"
            onClick={() =>
              setBannerText(
                '🏥 বুকে চাপ ব্যথা, শ্বাসকষ্ট বা স্ট্রোকের লক্ষণ দেখা দিলে দেরি না করে নিকটস্থ হাসপাতালের জরুরি বিভাগে যান।',
              )
            }
            className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-[11px] text-rose-300"
          >
            + Urgent Care Template
          </button>
        </div>

        {data && data.banners.length > 0 && (
          <div className="mt-4 space-y-2">
            {data.banners.map((b) => (
              <div
                key={b.bannerId}
                className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-950/20 px-3.5 py-2 text-xs text-amber-100"
              >
                <span>{b.message}</span>
                <button
                  type="button"
                  onClick={() => deleteBanner(b.bannerId)}
                  className="ml-3 shrink-0 rounded bg-rose-500/20 px-2.5 py-1 text-[11px] text-rose-300"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RBAC Matrix */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data?.roles.map((role) => (
          <div key={role.name} className="rounded-xl border border-slate-800 bg-slate-900/90 p-4">
            <h3 className="mb-3 text-sm font-bold text-emerald-300">
              🔐 Role Permissions Matrix: {role.name}
            </h3>
            <div className="space-y-2 text-xs">
              {Object.entries(role.permissions || {}).map(([permGroup, flags]) => (
                <div
                  key={permGroup}
                  className="rounded-lg border border-slate-800 bg-slate-950 p-2.5"
                >
                  <div className="mb-1.5 font-mono text-[11px] font-bold text-cyan-300">
                    {permGroup}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(flags || {}).map(([k, val]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => toggleRolePerm(role.name, permGroup, k, Boolean(val))}
                        className={`rounded-md border px-2.5 py-1 font-mono text-[11px] ${
                          val
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                            : 'border-slate-700 bg-slate-900 text-slate-400'
                        }`}
                      >
                        {k}: {val ? 'ON' : 'OFF'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Audit Trail */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <h3 className="mb-3 text-sm font-bold text-white">
          📜 Admin & Clinical Governance Audit Log ({data?.auditLogs.length || 0} recent events)
        </h3>
        <div className="max-h-72 space-y-1.5 overflow-y-auto font-mono text-xs">
          {data?.auditLogs.map((entry, idx) => (
            <div
              key={entry.eventId || idx}
              className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-950 px-3 py-2 text-[11px]"
            >
              <span className="text-emerald-400">{entry.action}</span>
              <span className="text-slate-300">{entry.actorEmail}</span>
              <span className="text-slate-500">
                {JSON.stringify(entry.details || {})} ·{' '}
                {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * MODULE 10: SYSTEM INFRASTRUCTURE, MONGODB INSPECTOR & DEMO SEEDER
 * ========================================================================== */
export function SystemInfrastructureOps({
  token,
  onMutated,
}: {
  token?: string;
  onMutated?: () => void;
}) {
  const [sys, setSys] = useState<SystemOpsResponse | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedNotice, setSeedNotice] = useState<string | null>(null);

  const loadSystem = useCallback(async () => {
    const res = await adminFetchJson<SystemOpsResponse>('/system', token);
    setSys(res);
  }, [token]);

  useEffect(() => {
    loadSystem();
  }, [loadSystem]);

  const handleSeedDemo = async () => {
    setSeeding(true);
    const res = await adminFetchJson<{ seeded: number }>('/system/seed-demo', token, {
      method: 'POST',
    });
    setSeedNotice(
      `✅ ${res.seeded}টি পূর্ণাঙ্গ ক্লিনিক্যাল কেস (ডেঙ্গু প্যানিক, CYP2C19 PGx ও ডায়নামিক চর্মরোগ সাব-এজেন্ট) ডাটাবেসে যুক্ত হয়েছে!`,
    );
    await loadSystem();
    onMutated?.();
    setSeeding(false);
  };

  if (!sys) return null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <div>
          <h2 className="text-base font-bold text-white">
            ⚙️ System Infrastructure, Node.js Telemetry & MongoDB Collection Inspector
          </h2>
          <p className="text-xs text-slate-400">
            {sys.runtime.platform} · Node {sys.runtime.nodeVersion} · {sys.runtime.cpus} vCPU · DB{' '}
            {sys.database.dbName}
          </p>
        </div>
        <button
          type="button"
          disabled={seeding}
          onClick={handleSeedDemo}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
        >
          {seeding ? 'Seeding…' : '🧪 Inject Realistic Clinical Demo Cases'}
        </button>
      </div>

      {seedNotice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-200">
          {seedNotice}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ['Process RSS Memory', `${sys.runtime.rssMb} MB`],
          ['V8 Heap Used', `${sys.runtime.heapUsedMb} / ${sys.runtime.heapTotalMb} MB`],
          [
            'Host RAM Free / Total',
            `${sys.runtime.freeSystemMemGb} / ${sys.runtime.totalSystemMemGb} GB`,
          ],
          ['MongoDB Collections', String(sys.database.totalCollections)],
          ['Total Stored Documents', sys.database.totalDocuments.toLocaleString()],
        ].map(([label, val]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="text-xs text-slate-400">{label}</div>
            <div className="mt-1 font-mono text-lg font-bold text-cyan-300">{val}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4">
        <h3 className="mb-3 text-sm font-bold text-white">
          🗄️ Live MongoDB Collections Document Counter ({sys.database.totalCollections} collections)
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
          {sys.database.collections.map((col) => (
            <div
              key={col.name}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs"
            >
              <span className="truncate font-mono text-slate-300">{col.name}</span>
              <span
                className={`ml-2 font-mono font-bold ${
                  col.count > 0 ? 'text-emerald-400' : 'text-slate-600'
                }`}
              >
                {col.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
