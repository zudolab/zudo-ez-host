CREATE TRIGGER hostname_allocations_permanent_update
BEFORE UPDATE ON hostname_allocations
BEGIN
	SELECT RAISE(ABORT, 'hostname allocations are permanent');
END;--> statement-breakpoint
CREATE TRIGGER hostname_allocations_permanent_delete
BEFORE DELETE ON hostname_allocations
BEGIN
	SELECT RAISE(ABORT, 'hostname allocations are permanent');
END;--> statement-breakpoint
CREATE TRIGGER publications_immutable_update
BEFORE UPDATE ON publications
BEGIN
	SELECT RAISE(ABORT, 'publications are immutable');
END;--> statement-breakpoint
CREATE TRIGGER publications_immutable_delete
BEFORE DELETE ON publications
BEGIN
	SELECT RAISE(ABORT, 'publications are immutable');
END;--> statement-breakpoint
CREATE TRIGGER publication_objects_immutable_update
BEFORE UPDATE ON publication_objects
BEGIN
	SELECT RAISE(ABORT, 'publication objects are immutable');
END;--> statement-breakpoint
CREATE TRIGGER publication_objects_immutable_delete
BEFORE DELETE ON publication_objects
BEGIN
	SELECT RAISE(ABORT, 'publication objects are immutable');
END;--> statement-breakpoint
CREATE TRIGGER project_heads_publication_generation_insert
BEFORE INSERT ON project_heads
WHEN NEW.publication_id IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM publications
	WHERE id = NEW.publication_id
		AND project_id = NEW.project_id
		AND generation = NEW.generation
)
BEGIN
	SELECT RAISE(ABORT, 'project head publication generation mismatch');
END;--> statement-breakpoint
CREATE TRIGGER project_heads_publication_generation_update
BEFORE UPDATE OF project_id, publication_id, generation ON project_heads
WHEN NEW.publication_id IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM publications
	WHERE id = NEW.publication_id
		AND project_id = NEW.project_id
		AND generation = NEW.generation
)
BEGIN
	SELECT RAISE(ABORT, 'project head publication generation mismatch');
END;--> statement-breakpoint
CREATE TRIGGER verified_objects_size_immutable
BEFORE UPDATE OF project_id, content_hash, size_bytes ON verified_objects
BEGIN
	SELECT RAISE(ABORT, 'verified object identity and size are immutable');
END;
