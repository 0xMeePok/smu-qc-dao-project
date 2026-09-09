import { Modal } from "./Modal.jsx";

export function AuditDetailPane({
  title,
  onClose,
  tabs = [],
  activeTab,
  onTabChange,
  children,
}) {
  return (
    <Modal labelledBy="audit-detail-title" onDismiss={onClose} className="audit-detail-pane">
      <div className="audit-detail-pane-header">
        <h2 id="audit-detail-title">{title}</h2>
        <button type="button" className="text-button" onClick={onClose}>Close</button>
      </div>
      {tabs.length > 1 && (
        <div className="audit-detail-pane-tabs" role="tablist" aria-label="Receipt type">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`audit-pane-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`audit-pane-panel-${tab.id}`}
              className={`admin-tab-btn ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <div
        className="audit-detail-pane-body"
        role={tabs.length > 1 ? "tabpanel" : undefined}
        id={tabs.length > 1 ? `audit-pane-panel-${activeTab}` : undefined}
        aria-labelledby={tabs.length > 1 ? `audit-pane-tab-${activeTab}` : "audit-detail-title"}
      >
        {children}
      </div>
    </Modal>
  );
}
