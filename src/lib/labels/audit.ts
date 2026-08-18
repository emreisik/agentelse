// Ham AuditLog.action string'lerini (örn. "work_plan.approved") okunur
// Türkçe cümlelere çevirir — sidebar aktivite akışı ve ileride eklenecek
// başka aktivite listeleri için tek kaynak.
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "setup.started": "Kurulum başlatıldı",
  "agency-setup.started": "Ajans kurulumu başlatıldı",
  "self-healing.stuck_job_reset": "Takılan iş otomatik onarıldı",
  "self-healing.dead_letter_requeued": "Başarısız iş yeniden kuyruğa alındı",
  "department.mode_changed": "Departman modu değiştirildi",
  "signal_profile.intensity_changed": "Sinyal profili yoğunluğu değiştirildi",
  "autonomy_policy.updated": "Otonomi politikası güncellendi",
  "work_plan.approved": "İş planı onaylandı",
  "work_plan.cancelled": "İş planı iptal edildi",
  "handoff.accepted": "Devir teklifi kabul edildi",
  "handoff.rejected": "Devir teklifi reddedildi",
  "project.created": "Proje oluşturuldu",
  "project.deleted": "Proje silindi",
  "command.received": "Komut alındı",
  "human_action.resolved": "İnsan eylemi çözümlendi",
  "integration_credential.connected": "Entegrasyon bağlandı",
  "integration_credential.disconnected": "Entegrasyon bağlantısı kesildi",
  "health.dead_letter_retried": "Ölü kuyruk kaydı yeniden denendi",
  "browser_profile.added": "Kanal eklendi",
  "browser_profile.marked_connected": "Kanal bağlı olarak işaretlendi",
  "browser_profile.disabled": "Kanal devre dışı bırakıldı",
  "approval.approved": "Onay verildi",
  "approval.rejected": "Onay reddedildi",
};

// Haritada olmayan (yeni eklenen) action'lar için sessizce kırılmak yerine
// kaba ama okunur bir dönüşüm: "some_thing.happened" -> "Some thing happened".
function humanize(action: string): string {
  const spaced = action.replace(/[._-]+/g, " ").trim();
  if (!spaced) return action;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function describeAuditAction(action: string): string {
  if (action.startsWith("reasoning.")) {
    return `AI muhakeme: ${humanize(action.slice("reasoning.".length))}`;
  }
  return AUDIT_ACTION_LABELS[action] ?? humanize(action);
}
