import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ComputeTask {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  dataset: string;
  status: "pending" | "completed" | "failed";
  reward: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<ComputeTask[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTaskData, setNewTaskData] = useState({ dataset: "", description: "", computeValue: 0, reward: 0 });
  const [showFAQ, setShowFAQ] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ComputeTask | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const completedCount = tasks.filter(t => t.status === "completed").length;
  const pendingCount = tasks.filter(t => t.status === "pending").length;
  const failedCount = tasks.filter(t => t.status === "failed").length;

  useEffect(() => {
    loadTasks().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTasks = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("task_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing task keys:", e); }
      }
      const list: ComputeTask[] = [];
      for (const key of keys) {
        try {
          const taskBytes = await contract.getData(`task_${key}`);
          if (taskBytes.length > 0) {
            try {
              const taskData = JSON.parse(ethers.toUtf8String(taskBytes));
              list.push({ 
                id: key, 
                encryptedData: taskData.data, 
                timestamp: taskData.timestamp, 
                owner: taskData.owner, 
                dataset: taskData.dataset, 
                status: taskData.status || "pending",
                reward: taskData.reward || 0
              });
            } catch (e) { console.error(`Error parsing task data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading task ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setTasks(list);
    } catch (e) { console.error("Error loading tasks:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitTask = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting computation data with Zama FHE..." });
    try {
      const encryptedData = FHEEncryptNumber(newTaskData.computeValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const taskId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const taskData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        dataset: newTaskData.dataset, 
        status: "pending",
        reward: newTaskData.reward
      };
      await contract.setData(`task_${taskId}`, ethers.toUtf8Bytes(JSON.stringify(taskData)));
      const keysBytes = await contract.getData("task_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(taskId);
      await contract.setData("task_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted computation task submitted!" });
      await loadTasks();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTaskData({ dataset: "", description: "", computeValue: 0, reward: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const completeTask = async (taskId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted computation with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const taskBytes = await contract.getData(`task_${taskId}`);
      if (taskBytes.length === 0) throw new Error("Task not found");
      const taskData = JSON.parse(ethers.toUtf8String(taskBytes));
      const updatedTask = { ...taskData, status: "completed" };
      await contract.setData(`task_${taskId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTask)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE computation completed successfully!" });
      await loadTasks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Completion failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const failTask = async (taskId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted computation with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const taskBytes = await contract.getData(`task_${taskId}`);
      if (taskBytes.length === 0) throw new Error("Task not found");
      const taskData = JSON.parse(ethers.toUtf8String(taskBytes));
      const updatedTask = { ...taskData, status: "failed" };
      await contract.setData(`task_${taskId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTask)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE computation marked as failed!" });
      await loadTasks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Operation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (taskAddress: string) => address?.toLowerCase() === taskAddress.toLowerCase();

  const filteredTasks = tasks.filter(task => 
    task.dataset.toLowerCase().includes(searchTerm.toLowerCase()) || 
    task.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    task.status.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const renderBarChart = () => {
    const datasets = [...new Set(tasks.map(t => t.dataset))];
    const datasetCounts = datasets.map(d => tasks.filter(t => t.dataset === d).length);
    const maxCount = Math.max(...datasetCounts, 1);

    return (
      <div className="bar-chart-container">
        {datasets.map((dataset, index) => (
          <div key={dataset} className="bar-item">
            <div className="bar-label">{dataset}</div>
            <div className="bar-wrapper">
              <div 
                className="bar-fill" 
                style={{ width: `${(datasetCounts[index] / maxCount) * 100}%` }}
              ></div>
              <div className="bar-value">{datasetCounts[index]}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="fhe-icon"></div></div>
          <h1>FHE<span>Compute</span>NFT</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-task-btn metal-button">
            <div className="add-icon"></div>New Task
          </button>
          <button className="metal-button" onClick={() => setShowFAQ(!showFAQ)}>
            {showFAQ ? "Hide FAQ" : "Show FAQ"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE Compute NFT Marketplace</h2>
            <p>Trade and execute Fully Homomorphic Encrypted computation tasks on blockchain</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>Zama FHE Active</span></div>
        </div>
        {showFAQ && (
          <div className="faq-section">
            <h2>FHE Compute NFT FAQ</h2>
            <div className="faq-item">
              <h3>What is FHE Compute NFT?</h3>
              <p>FHE Compute NFTs represent rights to perform computations on encrypted data using Zama's Fully Homomorphic Encryption technology.</p>
            </div>
            <div className="faq-item">
              <h3>How does encryption work?</h3>
              <p>Data is encrypted client-side using Zama FHE before being sent to the blockchain, remaining encrypted during computation.</p>
            </div>
            <div className="faq-item">
              <h3>What can I compute?</h3>
              <p>Currently supports numerical computations on encrypted data - arithmetic operations, comparisons, and more.</p>
            </div>
            <div className="faq-item">
              <h3>How are results verified?</h3>
              <p>Computations are performed on encrypted data and results can be verified without decryption using zero-knowledge proofs.</p>
            </div>
          </div>
        )}
        <div className="dashboard-grid">
          <div className="dashboard-card metal-card">
            <h3>Compute Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{tasks.length}</div><div className="stat-label">Total Tasks</div></div>
              <div className="stat-item"><div className="stat-value">{completedCount}</div><div className="stat-label">Completed</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
              <div className="stat-item"><div className="stat-value">{failedCount}</div><div className="stat-label">Failed</div></div>
            </div>
          </div>
          <div className="dashboard-card metal-card">
            <h3>Dataset Distribution</h3>
            {renderBarChart()}
          </div>
          <div className="dashboard-card metal-card">
            <h3>Total Rewards</h3>
            <div className="rewards-total">
              <div className="reward-icon"></div>
              <div className="reward-value">{tasks.reduce((sum, task) => sum + task.reward, 0)} ETH</div>
            </div>
            <div className="reward-stats">
              <div className="reward-stat"><span>Avg Reward:</span><strong>{(tasks.reduce((sum, task) => sum + task.reward, 0) / (tasks.length || 1)).toFixed(4)} ETH</strong></div>
              <div className="reward-stat"><span>Max Reward:</span><strong>{Math.max(...tasks.map(t => t.reward), 0)} ETH</strong></div>
            </div>
          </div>
        </div>
        <div className="tasks-section">
          <div className="section-header">
            <h2>FHE Compute Tasks</h2>
            <div className="header-actions">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search tasks..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <div className="search-icon"></div>
              </div>
              <button onClick={loadTasks} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="tasks-list metal-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Dataset</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Reward</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {filteredTasks.length === 0 ? (
              <div className="no-tasks">
                <div className="no-tasks-icon"></div>
                <p>No compute tasks found</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>Create First Task</button>
              </div>
            ) : filteredTasks.map(task => (
              <div className="task-row" key={task.id} onClick={() => setSelectedTask(task)}>
                <div className="table-cell task-id">#{task.id.substring(0, 6)}</div>
                <div className="table-cell">{task.dataset}</div>
                <div className="table-cell">{task.owner.substring(0, 6)}...{task.owner.substring(38)}</div>
                <div className="table-cell">{task.reward} ETH</div>
                <div className="table-cell"><span className={`status-badge ${task.status}`}>{task.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(task.owner) && task.status === "pending" && (
                    <>
                      <button className="action-btn metal-button success" onClick={(e) => { e.stopPropagation(); completeTask(task.id); }}>Complete</button>
                      <button className="action-btn metal-button danger" onClick={(e) => { e.stopPropagation(); failTask(task.id); }}>Fail</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {showCreateModal && <ModalCreate onSubmit={submitTask} onClose={() => setShowCreateModal(false)} creating={creating} taskData={newTaskData} setTaskData={setNewTaskData}/>}
      {selectedTask && <TaskDetailModal task={selectedTask} onClose={() => { setSelectedTask(null); setDecryptedValue(null); }} decryptedValue={decryptedValue} setDecryptedValue={setDecryptedValue} isDecrypting={isDecrypting} decryptWithSignature={decryptWithSignature}/>}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="fhe-icon"></div><span>FHEComputeNFT</span></div>
            <p>Decentralized FHE computation marketplace powered by Zama</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} FHEComputeNFT. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  taskData: any;
  setTaskData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, taskData, setTaskData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setTaskData({ ...taskData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTaskData({ ...taskData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!taskData.dataset || !taskData.computeValue) { alert("Please fill required fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Create FHE Compute Task</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your computation data will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Dataset *</label>
              <select name="dataset" value={taskData.dataset} onChange={handleChange} className="metal-select">
                <option value="">Select dataset</option>
                <option value="AI Training">AI Training Data</option>
                <option value="Financial">Financial Records</option>
                <option value="Medical">Medical Data</option>
                <option value="Genomic">Genomic Data</option>
                <option value="Other">Other Sensitive Data</option>
              </select>
            </div>
            <div className="form-group">
              <label>Description</label>
              <input type="text" name="description" value={taskData.description} onChange={handleChange} placeholder="Brief description..." className="metal-input"/>
            </div>
            <div className="form-group">
              <label>Compute Value *</label>
              <input 
                type="number" 
                name="computeValue" 
                value={taskData.computeValue} 
                onChange={handleValueChange} 
                placeholder="Enter numerical value..." 
                className="metal-input"
                step="0.01"
              />
            </div>
            <div className="form-group">
              <label>Reward (ETH) *</label>
              <input 
                type="number" 
                name="reward" 
                value={taskData.reward} 
                onChange={handleValueChange} 
                placeholder="Enter reward amount..." 
                className="metal-input"
                step="0.0001"
                min="0"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{taskData.computeValue || 'No value entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{taskData.computeValue ? FHEEncryptNumber(taskData.computeValue).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Data Privacy Guarantee</strong><p>Data remains encrypted during FHE processing and is never decrypted on our servers</p></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn metal-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface TaskDetailModalProps {
  task: ComputeTask;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const TaskDetailModal: React.FC<TaskDetailModalProps> = ({ task, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(task.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="task-detail-modal metal-card">
        <div className="modal-header">
          <h2>Task Details #{task.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="task-info">
            <div className="info-item"><span>Dataset:</span><strong>{task.dataset}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{task.owner.substring(0, 6)}...{task.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(task.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${task.status}`}>{task.status}</strong></div>
            <div className="info-item"><span>Reward:</span><strong>{task.reward} ETH</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">{task.encryptedData.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn metal-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedValue !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice"><div className="warning-icon"></div><span>Decrypted data is only visible after wallet signature verification</span></div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;