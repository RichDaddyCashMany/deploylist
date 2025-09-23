export type DeployStatus = "success" | "failed" | "running" | "canceled";

export interface DeployRecord {
  id: string;
  title: string;
  projectName: string; // 唯一项目名
  operator: string; // 运行人
  environment: string; // 部署环境
  branch: string; // 代码分支
  commit: string; // 代码提交记录
  note?: string; // 备注
  deployedAt: string; // ISO 时间串
  status: DeployStatus; // 部署状态
}

export interface CreateDeployPayload {
  title: string;
  projectName: string;
  operator: string;
  environment: string;
  branch: string;
  commit: string;
  note?: string;
  deployedAt?: string;
  status: DeployStatus;
}


