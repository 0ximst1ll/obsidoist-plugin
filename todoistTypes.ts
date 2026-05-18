export type TodoistId = string;

export type TodoistProject = {
	id: TodoistId;
	name: string;
};

export type TodoistDue = {
	date?: string;
	datetime?: string;
	is_recurring?: boolean;
	isRecurring?: boolean;
};

export type TodoistTask = {
	id: TodoistId;
	content: string;
	isCompleted?: boolean;
	is_completed?: boolean;
	projectId?: TodoistId;
	project_id?: TodoistId;
	due?: TodoistDue | null;
	dueDate?: string;
	isRecurring?: boolean;
};

