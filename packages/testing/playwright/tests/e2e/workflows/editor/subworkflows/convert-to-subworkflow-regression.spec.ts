import { nanoid } from 'nanoid';

import { test, expect } from '../../../../../fixtures/base';

/**
 * Regression tests for GHC-7788
 * Bug: Convert to sub-workflow creates child workflow at root instead of parent folder
 * and loses internal node connections
 */
test.describe(
	'Convert to Sub-workflow - Folder and Connections (GHC-7788)',
	{
		annotation: [{ type: 'owner', description: 'Catalysts' }],
	},
	() => {
		test('should create sub-workflow in the same folder as parent workflow', async ({
			n8n,
			api,
		}) => {
			// Setup: Create a project with folder
			const projectId = await n8n.start.fromNewProjectBlankCanvas();
			const folder = await api.projects.createFolder(projectId, 'Test Folder');

			// Add connected nodes to canvas
			await n8n.canvas.addNode('Manual Trigger');
			await n8n.canvas.addNode('Edit Fields (Set)', { closeNDV: true });
			await n8n.canvas.addNode('Edit Fields (Set)', { closeNDV: true });

			// Save workflow in the folder
			const workflowName = `Parent Workflow ${nanoid()}`;
			await n8n.canvas.saveWorkflow({ name: workflowName });

			// Move workflow to folder via API
			const workflows = await api.workflows.getWorkflows();
			const parentWorkflow = workflows.find((w: any) => w.name === workflowName);
			expect(parentWorkflow).toBeDefined();

			await api.request.patch(`/rest/workflows/${parentWorkflow.id}`, {
				data: {
					versionId: parentWorkflow.versionId,
					parentFolderId: folder.id,
				},
			});

			// Convert the second Edit Fields node to sub-workflow
			await n8n.canvas.rightClickNode('Edit Fields (Set)1');
			await n8n.canvas.clickContextMenuAction('Convert node to sub-workflow');
			await n8n.canvas.convertToSubworkflowModal.waitForModal();
			await n8n.canvas.convertToSubworkflowModal.clickSubmitButton();
			await n8n.canvas.convertToSubworkflowModal.waitForClose();

			// Wait for the operation to complete
			await n8n.page.waitForTimeout(1000);

			// Get all workflows to find the sub-workflow
			const allWorkflows = await api.workflows.getWorkflows();

			// Find the newly created sub-workflow (should start with "My Sub-workflow")
			const subWorkflow = allWorkflows.find(
				(w: any) => w.name.includes('My Sub-workflow') && w.id !== parentWorkflow.id,
			);

			expect(subWorkflow).toBeDefined();

			// EXPECTED: Sub-workflow should be in the same folder as parent
			// ACTUAL (BUG): Sub-workflow is at root (parentFolderId is null/undefined)
			expect(subWorkflow.parentFolderId).toBe(folder.id);
		});

		test('should preserve internal connections when converting nodes to sub-workflow', async ({
			n8n,
		}) => {
			// Import a workflow with connected nodes
			await n8n.start.fromImportedWorkflow('Subworkflow-extraction-workflow.json');

			await expect(n8n.canvas.getCanvasNodes()).toHaveCount(7);

			// Select multiple connected Edit Fields nodes
			await n8n.canvas.nodeByName('Edit Fields0').click();
			await n8n.canvas.extendSelectionWithArrows('right'); // Select Edit Fields1

			// Convert selection to sub-workflow
			await n8n.canvas.openCanvasContextMenu();
			await n8n.canvas.clickContextMenuAction('Convert 2 nodes to sub-workflow');
			await n8n.canvas.convertToSubworkflowModal.waitForModal();
			await n8n.canvas.convertToSubworkflowModal.clickSubmitButton();
			await n8n.canvas.convertToSubworkflowModal.waitForClose();

			// Wait for the operation to complete
			await n8n.page.waitForTimeout(1000);

			// Get all workflows to find the sub-workflow
			const workflows = await n8n.api.workflows.getWorkflows();
			const subWorkflow = workflows.find((w: any) => w.name.includes('My Sub-workflow'));

			expect(subWorkflow).toBeDefined();

			// Fetch the full sub-workflow data to check connections
			const response = await n8n.api.request.get(`/rest/workflows/${subWorkflow.id}`);
			expect(response.ok()).toBe(true);

			const subWorkflowData = await response.json();
			const actualSubWorkflow = subWorkflowData.data ?? subWorkflowData;

			// EXPECTED: Sub-workflow should have connections between the nodes
			// The sub-workflow should have:
			// - Start trigger node
			// - Edit Fields0
			// - Edit Fields1
			// With connections: Start → Edit Fields0 → Edit Fields1

			// Check that we have the expected nodes
			expect(actualSubWorkflow.nodes).toBeDefined();
			expect(actualSubWorkflow.nodes.length).toBeGreaterThanOrEqual(3);

			// EXPECTED: connections object should have entries
			// ACTUAL (BUG): connections might be empty or missing internal edges
			expect(actualSubWorkflow.connections).toBeDefined();

			// The connections should not be empty
			const connectionKeys = Object.keys(actualSubWorkflow.connections);
			expect(connectionKeys.length).toBeGreaterThan(0);

			// Verify that the nodes are actually connected (not just present)
			// At minimum, Start should connect to first Edit Fields
			// and first Edit Fields should connect to second Edit Fields
			let hasStartConnection = false;
			let hasInternalConnection = false;

			for (const [sourceNode, outputs] of Object.entries(actualSubWorkflow.connections)) {
				const outputConnections = outputs as any;
				if (outputConnections?.main?.[0]?.length > 0) {
					if (sourceNode.includes('Start')) {
						hasStartConnection = true;
					} else {
						hasInternalConnection = true;
					}
				}
			}

			// EXPECTED: Both connections should exist
			expect(hasStartConnection).toBe(true);
			expect(hasInternalConnection).toBe(true);
		});
	},
);
